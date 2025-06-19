# Configurable Command MCP Server

A flexible Model Context Protocol (MCP) server that allows you to define and execute arbitrary command-line tools through configuration files. Perfect for giving Claude Desktop access to specific command-line utilities in a secure, controlled manner.

## Features

- 🛠️ **Configuration-driven**: Define tools via JSON without modifying code
- 🔒 **Secure execution**: Parameter sanitization, directory restrictions, and command allowlisting
- ⚡ **Rate limiting**: Prevent abuse with configurable execution limits
- 📝 **Parameter validation**: Type checking, patterns, and required/optional parameters
- 🎯 **Directory scoping**: Restrict tool execution to specific directories
- ⏱️ **Timeout control**: Configurable execution timeouts per tool
- 📊 **Output management**: Size limits and structured result formatting

## Setup Instructions

### 1. Create the project directory and install dependencies

```bash
cd /Users/dewoller/code/generic_mcp
npm install
```

### 2. Build the TypeScript code

```bash
npm run build
```

### 3. Configure your tools

Edit the `tools.json` file to define your command-line tools. The file is already configured with useful examples like:
- `list_files`: List directory contents
- `grep_search`: Search for patterns in files
- `word_count`: Count lines/words/characters
- `git_status`: Check git repository status
- `find_files`: Find files by pattern
- And more!

### 4. Configure Claude Desktop

Add the following to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "command-executor": {
      "command": "node",
      "args": ["/Users/dewoller/code/generic_mcp/dist/index.js"],
      "env": {
        "CONFIG_PATH": "/Users/dewoller/code/generic_mcp/tools.json"
      }
    }
  }
}
```

### 5. Restart Claude Desktop

After saving the configuration, restart Claude Desktop to load the MCP server.

## Testing the Installation

### Run Integration Tests

```bash
npm run test:integration
```

This will test several tools and show you their output.

### Manual Testing in Development Mode

```bash
# Run in development mode (with TypeScript)
npm run dev

# Or run the built version
npm start
```

## Usage Examples

Once configured, you can ask Claude to use these tools:

- "List all JavaScript files in my code directory"
- "Search for TODO comments in the project"
- "Show me the git status"
- "Count lines in all Python files"
- "Find all markdown files"

## Adding Custom Tools

To add a new tool, edit `tools.json`:

```json
{
  "name": "my_tool",
  "description": "Description for Claude",
  "command": "actual-command",
  "args": ["-flag", "{parameter}"],
  "parameters