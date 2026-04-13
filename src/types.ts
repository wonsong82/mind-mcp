export interface MemoryConfig {
  memory: {
    short_term: {
      limit: number;
    };
    long_term: {
      page_size: number;
    };
  };
}

export interface MemoryTopic {
  topic: string;
  summary: string;
  updated: string;
}

export interface LogEntry {
  id: number;
  summary: string;
  context: string;
  interaction: string;
}

export interface MemoryBootResult {
  topics: MemoryTopic[];
  long_term_count: number;
  long_term_pages: number;
}

export interface MemorySearchResult {
  topics: MemoryTopic[];
  page: number;
  total_pages: number;
  total_count: number;
}

export interface MemoryLoadFoundResult {
  found: true;
  content: string;
}

export interface MemoryLoadNotFoundResult {
  found: false;
}

export type MemoryLoadResult = MemoryLoadFoundResult | MemoryLoadNotFoundResult;

export interface MemoryWriteLogInput {
  summary: string;
  context?: string;
  interaction: string;
}

export interface MemoryWriteInput {
  topic: string;
  summary: string;
  content: string;
  log_entry?: MemoryWriteLogInput;
  response?: string;
}

export interface MemoryWriteResult {
  success: true;
  log_id?: number;
}
