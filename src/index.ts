#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration schema
const ToolConfigSchema = z.object({
  name: z.string(),
  description: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  parameters: z.record(z.object({
    type: z.enum(["string", "number", "boolean", "array"]),
    description: z.string().optional(),
    required: z.boolean().default(true),
    default: z.any().optional(),
    pattern: z.string().optional(),
    items: z.object({
      type: z.enum(["string", "number", "boolean"]).optional(),
    }).optional(),
  })).default({}),
  allowedDirectories: z.array(z.string()).optional(),
  requiresApproval: z.boolean().default(false),
  timeout: z.number().min(1000).max(300000).default(30000),
  maxOutputSize: z.number().default(10 * 1024 * 1024), // 10MB
});

const ConfigSchema = z.object({
  tools: z.array(ToolConfigSchema),
  security: z.object({
    allowedCommands: z.array(z.string()).optional(),
    blockedPatterns: z.array(z.string()).optional(),
    maxExecutionsPerMinute: z.number().default(10),
  }).optional(),
});

type ToolConfig = z.infer<typeof ToolConfigSchema>;
type Config = z.infer<typeof ConfigSchema>;

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
  executionTime: number;
}

class ConfigurableCommandServer {
  private server: Server;
  private config: Config | null = null;
  private rateLimiter = new Map<string, number[]>();
  private configPath: string;

  constructor() {
    this.server = new Server(
      {
        name: "configurable-command-executor",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Default config path
    this.configPath = process.env.CONFIG_PATH || path.join(__dirname, "../tools.json");
    
    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (!this.config) {
        return { tools: [] };
      }

      const tools: Tool[] = this.config.tools.map((toolConfig) => ({
        name: toolConfig.name,
        description: toolConfig.description,
        inputSchema: {
          type: "object",
          properties: Object.entries(toolConfig.parameters).reduce(
            (acc, [key, param]) => {
              acc[key] = {
                type: param.type,
                description: param.description,
                default: param.default,
                pattern: param.pattern,
              };
              return acc;
            },
            {} as any
          ),
          required: Object.entries(toolConfig.parameters)
            .filter(([_, param]) => param.required)
            .map(([key]) => key),
        },
      }));

      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!this.config) {
        throw new Error("No configuration loaded");
      }

      const { name, arguments: args } = request.params;
      const toolConfig = this.config.tools.find((t) => t.name === name);

      if (!toolConfig) {
        throw new Error(`Tool not found: ${name}`);
      }

      // Rate limiting
      if (!this.checkRateLimit("default")) {
        throw new Error("Rate limit exceeded");
      }

      // Validate parameters
      const validatedArgs = await this.validateArguments(toolConfig, args);

			// Check file paths if the tool has allowedDirectories restriction
      if (toolConfig.allowedDirectories && validatedArgs.files) {
        // For array of files, check each one
        if (Array.isArray(validatedArgs.files)) {
          for (const file of validatedArgs.files) {
            const resolvedFile = path.resolve(file);
            if (!this.isPathAllowed(resolvedFile, toolConfig.allowedDirectories)) {
              throw new Error(`File not in allowed directories: ${file}`);
            }
          }
        }
      } else if (toolConfig.allowedDirectories && validatedArgs.file) {
        // For single file parameter
        const resolvedFile = path.resolve(validatedArgs.file);
        if (!this.isPathAllowed(resolvedFile, toolConfig.allowedDirectories)) {
          throw new Error(`File not in allowed directories: ${validatedArgs.file}`);
        }
      }

      // Substitute parameters in args
      const processedArgs = this.substituteParameters(
        toolConfig.args,
        validatedArgs
      );

      // Execute command
      try {
        const result = await this.executeCommand(
          toolConfig.command,
          processedArgs,
          {
            timeout: toolConfig.timeout,
            maxOutputSize: toolConfig.maxOutputSize,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: this.formatCommandResult(
                toolConfig.command,
                processedArgs,
                result
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error executing command: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async loadConfiguration() {
    try {
      const configContent = await fs.readFile(this.configPath, "utf-8");
      const rawConfig = JSON.parse(configContent);
      this.config = ConfigSchema.parse(rawConfig);
      console.error(`Loaded configuration from ${this.configPath}`);
    } catch (error) {
      console.error(`Failed to load configuration: ${error}`);
      // Load default configuration
      this.config = {
        tools: [
          {
            name: "echo",
            description: "Echo a message",
            command: "echo",
            args: ["{message}"],
            parameters: {
              message: {
                type: "string",
                description: "Message to echo",
                required: true,
              },
            },
            requiresApproval: false,
            timeout: 5000,
            maxOutputSize: 1024 * 1024,
          },
        ],
      };
    }
  }

  private checkRateLimit(userId: string): boolean {
    const now = Date.now();
    const userExecutions = this.rateLimiter.get(userId) || [];
    const maxPerMinute = this.config?.security?.maxExecutionsPerMinute || 10;

    // Remove executions older than 1 minute
    const recentExecutions = userExecutions.filter(
      (time) => now - time < 60000
    );
    this.rateLimiter.set(userId, recentExecutions);

    if (recentExecutions.length >= maxPerMinute) {
      return false;
    }

    recentExecutions.push(now);
    this.rateLimiter.set(userId, recentExecutions);
    return true;
  }

  private async validateArguments(
    toolConfig: ToolConfig,
    args: any
  ): Promise<Record<string, any>> {
    const validated: Record<string, any> = {};

    for (const [key, param] of Object.entries(toolConfig.parameters)) {
      const value = args[key];

      if (value === undefined && param.required) {
        if (param.default !== undefined) {
          validated[key] = param.default;
        } else {
          throw new Error(`Missing required parameter: ${key}`);
        }
      } else if (value !== undefined) {
        // Type validation
        if (param.type === "string" && typeof value !== "string") {
          throw new Error(`Parameter ${key} must be a string`);
        }
        if (param.type === "number" && typeof value !== "number") {
          throw new Error(`Parameter ${key} must be a number`);
        }
        if (param.type === "boolean" && typeof value !== "boolean") {
          throw new Error(`Parameter ${key} must be a boolean`);
        }
        if (param.type === "array") {
          if (!Array.isArray(value)) {
            throw new Error(`Parameter ${key} must be an array`);
          }
          // No pattern validation for arrays - sanitizeParameter handles security
        }

        // Pattern validation for strings
        if (param.type === "string" && param.pattern) {
          const regex = new RegExp(param.pattern);
          if (!regex.test(value)) {
            throw new Error(
              `Parameter ${key} does not match pattern: ${param.pattern}`
            );
          }
        }

        validated[key] = value;
      }
    }

    return validated;
  }

  private substituteParameters(
    template: string[],
    params: Record<string, any>
  ): string[] {
    const result: string[] = [];
    
    for (const arg of template) {
      // Check if this argument contains a parameter that should be expanded to multiple values
      if (arg.match(/\{(\w+)\}/)) {
        const paramName = arg.match(/\{(\w+)\}/)![1];
        const value = params[paramName];
        
        // Special handling for array parameters (like file lists)
        if (Array.isArray(value)) {
          // Add each array item as a separate argument
          for (const item of value) {
            result.push(this.sanitizeParameter(String(item)));
          }
        } else if (value !== undefined) {
          // Normal single-value substitution
          result.push(arg.replace(/\{(\w+)\}/g, (match, key) => {
            const val = params[key];
            return val !== undefined ? this.sanitizeParameter(String(val)) : match;
          }));
        } else {
          result.push(arg); // Keep original if no substitution
        }
      } else {
        result.push(arg);
      }
    }
    
    return result;
  }

  private sanitizeParameter(value: string): string {
    // Only block the most dangerous shell metacharacters
    // Since we're using proper quoting in our shell commands,
    // we can allow quotes and most other characters in filenames
    const dangerous = /[;&|`$<>\\\\]/;
    if (dangerous.test(value)) {
      throw new Error(`Parameter contains dangerous characters: ${value}`);
    }
    
    // Check for null bytes which can cause issues
    if (value.includes('\0')) {
      throw new Error(`Parameter contains null byte`);
    }
    
    return value;
  }

  private isPathAllowed(dir: string, allowedDirs: string[]): boolean {
    const resolvedDir = path.resolve(dir);
    return allowedDirs.some((allowed) =>
      resolvedDir.startsWith(path.resolve(allowed))
    );
  }

  private async executeCommand(
    command: string,
    args: string[],
    options: { timeout?: number; maxOutputSize?: number } = {}
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      // Check if command is allowed
      if (this.config?.security?.allowedCommands) {
        if (!this.config.security.allowedCommands.includes(command)) {
          reject(new Error(`Command not allowed: ${command}`));
          return;
        }
      }

      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: options.timeout || 30000,
        killSignal: "SIGTERM",
      });

      let stdout = "";
      let stderr = "";
      let outputSize = 0;
      const maxOutputSize = options.maxOutputSize || 10 * 1024 * 1024;

      const checkOutputSize = (data: Buffer) => {
        outputSize += data.length;
        if (outputSize > maxOutputSize) {
          child.kill("SIGTERM");
          reject(new Error("Output size limit exceeded"));
        }
      };

      child.stdout?.on("data", (data) => {
        checkOutputSize(data);
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        checkOutputSize(data);
        stderr += data.toString();
      });

      child.on("error", (error) => {
        reject(new Error(`Failed to start command: ${error.message}`));
      });

      child.on("close", (code, signal) => {
        const executionTime = Date.now() - startTime;
        const result: CommandResult = {
          exitCode: code || 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          success: code === 0,
          executionTime,
        };

        resolve(result);
      });
    });
  }

  private formatCommandResult(
    command: string,
    args: string[],
    result: CommandResult
  ): string {
    const parts = [
      `Command: ${command} ${args.join(" ")}`,
      `Exit Code: ${result.exitCode}`,
      `Execution Time: ${result.executionTime}ms`,
      "",
    ];

    if (result.stdout) {
      parts.push("Output:", result.stdout, "");
    }

    if (result.stderr) {
      parts.push("Errors:", result.stderr, "");
    }

    if (!result.success) {
      parts.push(`Command failed with exit code ${result.exitCode}`);
    }

    return parts.join("\n");
  }

  async start() {
    await this.loadConfiguration();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("MCP Server running on stdio");
  }
}

// Start the server
const server = new ConfigurableCommandServer();
server.start().catch(console.error);
