#!/usr/bin/env node
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MCPTestClient {
  constructor() {
    this.serverPath = path.join(__dirname, '..', 'dist', 'index.js');
  }

  async testTool(toolName, args = {}) {
    return new Promise((resolve, reject) => {
      const server = spawn('node', [this.serverPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let output = '';
      let error = '';

      server.stdout.on('data', (data) => {
        output += data.toString();
      });

      server.stderr.on('data', (data) => {
        error += data.toString();
      });

      server.on('close', (code) => {
        resolve({ output, error, code });
      });

      // Send initialization request
      const initRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "test-client",
            version: "1.0.0"
          }
        }
      };

      server.stdin.write(JSON.stringify(initRequest) + '\n');

      // Wait a bit then send tool list request
      setTimeout(() => {
        const listRequest = {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {}
        };
        server.stdin.write(JSON.stringify(listRequest) + '\n');
      }, 100);

      // Send tool call request
      setTimeout(() => {
        const callRequest = {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args
          }
        };
        server.stdin.write(JSON.stringify(callRequest) + '\n');

        // Close after giving time to respond
        setTimeout(() => {
          server.stdin.end();
        }, 500);
      }, 200);
    });
  }

  parseResponses(output) {
    const lines = output.split('\n').filter(line => line.trim());
    const responses = [];
    
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.jsonrpc === "2.0") {
          responses.push(parsed);
        }
      } catch (e) {
        // Skip non-JSON lines
      }
    }
    
    return responses;
  }

  async runTests() {
    console.log('🧪 Running MCP Integration Tests\n');

    const tests = [
      {
        name: 'Echo Test',
        tool: 'echo',
        args: { message: 'Hello MCP!' },
        description: 'Testing basic echo functionality'
      },
      {
        name: 'List Files Test',
        tool: 'list_files',
        args: { directory: '.' },
        description: 'Testing directory listing'
      },
      {
        name: 'Word Count Test',
        tool: 'word_count',
        args: { file: 'package.json', flags: '-l' },
        description: 'Testing word count on package.json'
      },
      {
        name: 'Git Status Test',
        tool: 'git_status',
        args: {},
        description: 'Testing git status command'
      }
    ];

    for (const test of tests) {
      console.log(`\n📋 ${test.name}`);
      console.log(`   ${test.description}`);
      
      try {
        const result = await this.testTool(test.tool, test.args);
        const responses = this.parseResponses(result.output);
        
        // Find the tool call response
        const toolResponse = responses.find(r => r.id === 3);
        
        if (toolResponse?.result?.content?.[0]?.text) {
          console.log('   ✅ Success!');
          console.log('   Output preview:');
          const preview = toolResponse.result.content[0].text
            .split('\n')
            .slice(0, 3)
            .map(line => `      ${line}`)
            .join('\n');
          console.log(preview);
          if (toolResponse.result.content[0].text.split('\n').length > 3) {
            console.log('      ...');
          }
        } else if (toolResponse?.error) {
          console.log(`   ❌ Error: ${toolResponse.error.message}`);
        } else {
          console.log('   ⚠️  No response received');
        }
      } catch (error) {
        console.log(`   ❌ Test failed: ${error.message}`);
      }
    }

    console.log('\n✨ Tests completed!\n');
  }
}

// Run tests
const tester = new MCPTestClient();
tester.runTests().catch(console.error);