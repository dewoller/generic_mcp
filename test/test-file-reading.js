#!/usr/bin/env node
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class FileReadingTest {
  constructor() {
    this.serverPath = path.join(__dirname, '..', 'dist', 'index.js');
    this.testFile = path.join(__dirname, 'sample.html');
  }

  async runServer(inputRequests) {
    return new Promise((resolve, reject) => {
      const server = spawn('node', [this.serverPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CONFIG_PATH: path.join(__dirname, '..', 'tools.json') }
      });

      let output = '';
      let error = '';
      let requestIndex = 0;

      server.stdout.on('data', (data) => {
        output += data.toString();
        
        // Process responses and send next request
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim() && line.includes('"jsonrpc"')) {
            try {
              const response = JSON.parse(line);
              console.log(`Response ${response.id}:`, JSON.stringify(response, null, 2));

              if (response.id === 2 && response.result && response.result.tools && response.result.tools.length > 0) {
                const toolSchema = response.result.tools[0];
                if (toolSchema.name === 'read_docs_by_list') {
                  const filesProp = toolSchema.inputSchema.properties.files;
                  if (typeof filesProp.pattern !== 'undefined') {
                    console.error('Test Error: files.pattern should be undefined. Got:', filesProp.pattern);
                    process.exitCode = 1; // Mark test as failed
                  }
                  const expectedPattern = "^[^\\x00-\\x1f;&|`$(){}\\[\\]<>'\"\\\\]+\\.(pdf|doc|docx|html|htm)$";
                  if (filesProp.items.pattern !== expectedPattern) {
                    console.error('Test Error: files.items.pattern is incorrect. Got:', filesProp.items.pattern, 'Expected:', expectedPattern);
                    process.exitCode = 1; // Mark test as failed
                  }
                }
              }
              
              // Send next request if available
              requestIndex++;
              if (requestIndex < inputRequests.length) {
                setTimeout(() => {
                  console.log(`Sending request ${requestIndex + 1}:`, JSON.stringify(inputRequests[requestIndex], null, 2));
                  server.stdin.write(JSON.stringify(inputRequests[requestIndex]) + '\n');
                }, 100);
              } else {
                // All requests sent, close after a delay
                setTimeout(() => {
                  server.stdin.end();
                }, 500);
              }
            } catch (e) {
              // Not JSON, ignore
            }
          }
        }
      });

      server.stderr.on('data', (data) => {
        error += data.toString();
        console.error('Server error:', data.toString());
      });

      server.on('close', (code) => {
        resolve({ output, error, code });
      });

      // Send first request
      console.log(`Sending request 1:`, JSON.stringify(inputRequests[0], null, 2));
      server.stdin.write(JSON.stringify(inputRequests[0]) + '\n');
    });
  }

  async testFileReading() {
    console.log('🧪 Testing MCP File Reading\n');

    // Create test file if it doesn't exist
    if (!fs.existsSync(this.testFile)) {
      console.log(`Creating test file: ${this.testFile}`);
      fs.writeFileSync(this.testFile, `<!DOCTYPE html>
<html>
<head>
    <title>Test Document</title>
</head>
<body>
    <h1>Sample Test Document</h1>
    <p>This is a test document for the MCP server.</p>
    <p>It contains some sample text that should be extracted by pandoc.</p>
    <ul>
        <li>Item 1</li>
        <li>Item 2</li>
        <li>Item 3</li>
    </ul>
    <p>End of document.</p>
</body>
</html>`);
    }

    const requests = [
      // Initialize
      {
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
      },
      // List tools
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      },
      // Call read_docs_by_list with our test file
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "read_docs_by_list",
          arguments: {
            files: [this.testFile]
          }
        }
      }
    ];

    try {
      console.log(`Test file location: ${this.testFile}\n`);
      const result = await this.runServer(requests);
      
      if (result.error && result.error.includes("Current directory not allowed: /")) {
        // Explicitly throw to ensure CI picks this up as a hard failure
        throw new Error("Test failed: Found 'Current directory not allowed: /' in stderr");
      }

      console.log('\n✨ Test completed!');
      console.log(`Exit code: ${result.code}`);
      
      if (result.error) {
        // stderr content is already printed by server.stderr.on('data')
        // but we can add a summary here if needed or ensure it's not empty if errors are expected
      }
      // If process.exitCode was set by an assertion, it will be used
    } catch (error) {
      console.error('❌ Test failed:', error);
      process.exitCode = 1; // Ensure test fails in CI
    }
  }
}

// Run the test
const tester = new FileReadingTest();
tester.testFileReading().catch(console.error);