#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from './core/tool-registry.js';
import { ExecutionContextImpl } from './core/execution-context.js';
import { logger } from './logger.js';
import { initTempFolder } from './screenshot-utils.js';
import { terminateOCR } from './ocr-utils.js';
import { getUserFriendlyErrorMessage, MCPError } from './errors.js';
import { getPerformanceMonitor } from './core/performance-monitor.js';

// Import tool handlers
import { screenshotToolHandlers } from './tools/screenshot-tools.js';
import { automationToolHandlers } from './tools/automation-tools.js';
import { windowToolHandlers } from './tools/window-tools.js';
import { ocrToolHandlers } from './tools/ocr-tools.js';
import { utilityToolHandlers } from './tools/utility-tools.js';

// Create server instance
const server = new Server(
  {
    name: "mac-commander",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Initialize tool registry
const toolRegistry = ToolRegistry.getInstance();

// Register all tool handlers
async function registerAllTools() {
  // Register screenshot tools
  toolRegistry.registerAll(screenshotToolHandlers);
  
  // Register automation tools
  toolRegistry.registerAll(automationToolHandlers);
  
  // Register window tools
  toolRegistry.registerAll(windowToolHandlers);
  
  // Register OCR tools
  toolRegistry.registerAll(ocrToolHandlers);
  
  // Register utility tools
  toolRegistry.registerAll(utilityToolHandlers);
  
  logger.info(`Registered ${toolRegistry.getToolNames().length} tools`);
}

// Setup signal handlers
process.on("SIGINT", async () => {
  logger.info("Received SIGINT, shutting down gracefully...");
  await cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("Received SIGTERM, shutting down gracefully...");
  await cleanup();
  process.exit(0);
});

// Cleanup function
async function cleanup() {
  try {
    logger.info("Starting cleanup...");
    
    // Stop performance monitoring
    try {
      const performanceMonitor = getPerformanceMonitor();
      performanceMonitor.stop();
      performanceMonitor.cleanup();
      logger.info("Performance monitoring stopped");
    } catch (error) {
      logger.warn("Error stopping performance monitor", error as Error);
    }
    
    await terminateOCR();
    logger.info("Cleanup completed");
  } catch (error) {
    logger.error("Error during cleanup", error as Error);
  }
}

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: toolRegistry.getToolsInfo(),
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const startTime = Date.now();
  const toolName = request.params.name;
  
  logger.info(`Executing tool: ${toolName}`);
  
  // Create execution context for this request
  const context = new ExecutionContextImpl();
  
  try {
    // Get the tool handler
    const handler = toolRegistry.getHandler(toolName);
    if (!handler) {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    
    // Validate permissions if needed
    if (handler.validatePermissions) {
      await handler.validatePermissions();
    }
    
    // Parse and validate arguments
    const args = handler.schema.parse(request.params.arguments);
    
    // Execute the tool
    const result = await handler.execute(args, context);
    
    const duration = Date.now() - startTime;
    const success = !result.isError;
    
    // Record tool execution for performance monitoring
    context.recordToolExecution?.(toolName, duration, success);
    
    logger.info(`Tool ${toolName} completed in ${duration}ms`, { success });
    
    // Return the result directly - it already has the correct format
    return result as any;
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    // Record failed tool execution for performance monitoring
    context.recordToolExecution?.(toolName, duration, false);
    
    logger.error(`Tool ${toolName} failed after ${duration}ms`, error as Error);
    
    // Clean up context on error
    context.cleanup();
    
    if (error instanceof MCPError) {
      return {
        content: [
          {
            type: "text",
            text: getUserFriendlyErrorMessage(error),
          },
        ],
        isError: true,
      };
    }
    
    return {
      content: [
        {
          type: "text",
          text: `Error executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  } finally {
    // Always clean up context
    context.cleanup();
  }
});

// Main function
async function main() {
  try {
    logger.info("Starting macOS Simulator MCP server...");
    
    // Initialize performance monitoring
    try {
      const performanceMonitor = getPerformanceMonitor({
        resourceMonitoringIntervalMs: 10000, // 10 seconds
        performanceReportIntervalMs: 300000, // 5 minutes
        enableAnomalyDetection: true,
        thresholds: {
          cpuUsageWarning: 80,
          cpuUsageCritical: 95,
          memoryUsageWarning: 85,
          memoryUsageCritical: 95,
          executionTimeWarning: 3000, // 3 seconds
          executionTimeCritical: 10000, // 10 seconds
          errorRateWarning: 0.1, // 10%
          errorRateCritical: 0.25, // 25%
          queueLengthWarning: 15,
          queueLengthCritical: 30
        }
      });
      
      performanceMonitor.start();
      logger.info("Performance monitoring started");
      
      // Set up alert handling
      performanceMonitor.on('thresholdViolation', ({ metricName, violation }) => {
        logger.warn(`Performance alert: ${metricName}`, {
          type: violation.type,
          value: violation.value,
          threshold: violation.threshold,
          consecutiveCount: violation.consecutiveCount
        });
      });
      
    } catch (error) {
      logger.warn("Could not initialize performance monitoring", error as Error);
    }
    
    // Initialize temp folder for screenshots
    await initTempFolder();
    
    // Register all tools
    await registerAllTools();
    
    // Create stdio transport
    const transport = new StdioServerTransport();
    
    // Connect server to transport
    await server.connect(transport);
    
    logger.info("macOS Simulator MCP server running with performance monitoring");
  } catch (error) {
    logger.error("Failed to start server", error as Error);
    process.exit(1);
  }
}

// Start the server
main().catch((error) => {
  logger.error("Fatal error", error as Error);
  process.exit(1);
});