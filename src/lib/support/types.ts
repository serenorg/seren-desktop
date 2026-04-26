export interface SupportReportErrorInfo {
  kind: string;
  message: string;
  stack: string[];
}

export interface SupportReportHttpInfo {
  method: string;
  url: string;
  status?: number;
  body?: string;
}

export interface SupportReportLogEntry {
  ts: string;
  level: "ERROR" | "WARN" | "INFO" | "DEBUG";
  module: string;
  message: string;
}

export interface SupportReportToolCall {
  name: string;
  id: string;
}

export interface SupportReportAgentContext {
  model?: string;
  provider?: string;
  region?: string;
  tool_calls: SupportReportToolCall[];
}

export interface SupportReportPayload {
  schema_version: 1;
  signature: string;
  install_id: string;
  session_id_hash: string;
  app_version: string;
  tauri_version: string;
  os: "darwin" | "linux" | "windows";
  arch: "aarch64" | "x86_64";
  timestamp: string;
  crash_recovery: boolean;
  truncated: boolean;
  error: SupportReportErrorInfo;
  http?: SupportReportHttpInfo;
  log_slice: SupportReportLogEntry[];
  agent_context?: SupportReportAgentContext;
}

export interface SupportReportIds {
  install_id: string;
  session_id_hash: string;
}

export interface SupportBuildInfo {
  app_version: string;
  tauri_version: string;
  os: string;
}

export interface SupportCaptureInput {
  kind: string;
  message: string;
  stack?: string[];
  http?: SupportReportHttpInfo;
  agentContext?: SupportReportAgentContext;
}
