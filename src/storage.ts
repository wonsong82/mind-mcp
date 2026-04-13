import { mkdir, readdir, readFile, rename, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import {
  LogEntry,
  MemoryBootResult,
  MemoryConfig,
  MemoryLoadResult,
  MemorySearchResult,
  MemoryTopic,
  MemoryWriteInput,
  MemoryWriteResult,
} from './types.js';

const DEFAULT_CONFIG: MemoryConfig = {
  memory: {
    short_term: {
      limit: 20,
    },
    long_term: {
      page_size: 20,
    },
  },
};

type FrontmatterData = {
  summary: string;
  updated: string;
};

type MemoryLocation = 'short' | 'long';

type ParsedMemoryFile = {
  frontmatter: FrontmatterData;
  body: string;
  rawContent: string;
};

export class MemoryStorage {
  readonly cwd: string;
  mindDir = '';
  memoryDir = '';
  shortDir = '';
  longDir = '';
  logsDir = '';
  configPath = '';
  lockDir = '';
  private resolved = false;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async ensureInitialized(): Promise<void> {
    if (!this.resolved) {
      await this.resolveRoot();
    }

    await mkdir(this.shortDir, { recursive: true });
    await mkdir(this.longDir, { recursive: true });
    await mkdir(this.logsDir, { recursive: true });
  }

  async memoryBoot(): Promise<MemoryBootResult> {
    await this.ensureInitialized();

    const [topics, longTermCount, config] = await Promise.all([
      this.listTopics('short'),
      this.countMarkdownFiles(this.longDir),
      this.readConfig(),
    ]);

    return {
      topics,
      long_term_count: longTermCount,
      long_term_pages:
        longTermCount === 0 ? 0 : Math.ceil(longTermCount / config.memory.long_term.page_size),
    };
  }

  async memorySearch(page = 1): Promise<MemorySearchResult> {
    await this.ensureInitialized();

    const [topics, config] = await Promise.all([this.listTopics('long'), this.readConfig()]);
    const totalCount = topics.length;
    const pageSize = config.memory.long_term.page_size;
    const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize);
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const start = (safePage - 1) * pageSize;

    return {
      topics: topics.slice(start, start + pageSize),
      page: safePage,
      total_pages: totalPages,
      total_count: totalCount,
    };
  }

  async memoryLoad(topic: string): Promise<MemoryLoadResult> {
    const normalizedTopic = this.normalizeTopic(topic);

    return this.withLock(async () => {
      const shortPath = this.topicPath('short', normalizedTopic);
      const longPath = this.topicPath('long', normalizedTopic);

      const shortExists = await this.pathExists(shortPath);
      const longExists = shortExists ? false : await this.pathExists(longPath);

      if (!shortExists && !longExists) {
        return { found: false };
      }

      if (longExists) {
        await rename(longPath, shortPath);
      }

      const memoryFile = await this.readMemoryFile(shortPath);
      const updated = this.nowIso();
      const rawContent = this.serializeMemoryDocument(
        {
          summary: memoryFile.frontmatter.summary,
          updated,
        },
        memoryFile.body,
      );

      await writeFile(shortPath, rawContent, 'utf8');
      await this.enforceShortTermLimit(normalizedTopic);

      return {
        found: true,
        content: rawContent,
      };
    });
  }

  async memoryLoadLog(topic: string, ids: number[]): Promise<LogEntry[]> {
    await this.ensureInitialized();

    const normalizedTopic = this.normalizeTopic(topic);
    const logPath = this.logPath(normalizedTopic);

    if (!(await this.pathExists(logPath))) {
      return [];
    }

    const wantedIds = new Set(ids);
    if (wantedIds.size === 0) {
      return [];
    }

    const entries = await this.readJsonl(logPath);
    return entries.filter((entry): entry is LogEntry => wantedIds.has(entry.id));
  }

  async memoryWrite(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    const normalizedTopic = this.normalizeTopic(input.topic);

    return this.withLock(async () => {
      const shortPath = this.topicPath('short', normalizedTopic);
      const longPath = this.topicPath('long', normalizedTopic);

      if (!(await this.pathExists(shortPath)) && (await this.pathExists(longPath))) {
        await rename(longPath, shortPath);
      }

      const rawContent = this.serializeMemoryDocument(
        {
          summary: input.summary,
          updated: this.nowIso(),
        },
        input.content,
      );

      await writeFile(shortPath, rawContent, 'utf8');
      await this.enforceShortTermLimit(normalizedTopic);

      if (!input.log_entry) {
        return { success: true };
      }

      const logEntry = {
        ...input.log_entry,
        context: input.response ?? input.log_entry.context ?? '',
      };

      const logPath = this.logPath(normalizedTopic);
      const existingEntries = await this.readJsonl(logPath);
      const maxId = existingEntries.reduce((currentMax, entry) => Math.max(currentMax, entry.id), 0);
      const logId = maxId + 1;

      await appendFile(
        logPath,
        `${JSON.stringify({ id: logId, ...logEntry })}\n`,
        'utf8',
      );

      return {
        success: true,
        log_id: logId,
      };
    });
  }

  async readConfig(): Promise<MemoryConfig> {
    await this.ensureInitialized();

    if (!(await this.pathExists(this.configPath))) {
      return { ...DEFAULT_CONFIG };
    }

    try {
      const raw = await readFile(this.configPath, 'utf8');
      const lines = raw.split(/\r?\n/);

      return {
        memory: {
          short_term: {
            limit: this.readConfigInteger(lines, 'short_term', 'limit', DEFAULT_CONFIG.memory.short_term.limit),
          },
          long_term: {
            page_size: this.readConfigInteger(
              lines,
              'long_term',
              'page_size',
              DEFAULT_CONFIG.memory.long_term.page_size,
            ),
          },
        },
      };
    } catch {
      return this.defaultConfig();
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureInitialized();
    await this.acquireLock();

    try {
      return await operation();
    } finally {
      await this.releaseLock();
    }
  }

  private async acquireLock(): Promise<void> {
    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline) {
      try {
        await mkdir(this.lockDir);
        return;
      } catch (error) {
        if (!this.isAlreadyExistsError(error)) {
          throw error;
        }
      }

      await this.sleep(50);
    }

    throw new Error(`Timed out acquiring lock at ${this.lockDir}`);
  }

  private async releaseLock(): Promise<void> {
    try {
      await rm(this.lockDir, { recursive: true, force: true });
    } catch {}
  }

  private async enforceShortTermLimit(activeTopic: string): Promise<void> {
    const config = await this.readConfig();
    const topics = await this.listTopics('short');

    if (topics.length <= config.memory.short_term.limit) {
      return;
    }

    const demotionCandidates = [...topics].sort((left, right) => {
      const updatedDelta = this.parseTimestamp(left.updated) - this.parseTimestamp(right.updated);
      if (updatedDelta !== 0) {
        return updatedDelta;
      }

      if (left.topic === activeTopic) {
        return 1;
      }

      if (right.topic === activeTopic) {
        return -1;
      }

      return left.topic.localeCompare(right.topic);
    });

    const topicToDemote = demotionCandidates[0];
    if (!topicToDemote) {
      return;
    }

    await rename(
      this.topicPath('short', topicToDemote.topic),
      this.topicPath('long', topicToDemote.topic),
    );
  }

  private async listTopics(location: MemoryLocation): Promise<MemoryTopic[]> {
    const directory = this.directoryFor(location);
    const files = await this.listMarkdownFiles(directory);
    const topics = await Promise.all(
      files.map(async (fileName) => {
        const topic = path.basename(fileName, '.md');
        const filePath = path.join(directory, fileName);
        const memoryFile = await this.readMemoryFile(filePath);

        return {
          topic,
          summary: memoryFile.frontmatter.summary,
          updated: memoryFile.frontmatter.updated,
        } satisfies MemoryTopic;
      }),
    );

    topics.sort((left, right) => this.parseTimestamp(right.updated) - this.parseTimestamp(left.updated));
    return topics;
  }

  private async resolveRoot(): Promise<void> {
    const wonflowooDir = path.join(this.cwd, '.wonflowoo');
    const wonflowooExists = await this.pathExists(wonflowooDir);

    this.mindDir = wonflowooExists ? path.join(wonflowooDir, 'workspace') : path.join(this.cwd, '.mind');
    this.memoryDir = path.join(this.mindDir, 'memory');
    this.shortDir = path.join(this.memoryDir, 'short');
    this.longDir = path.join(this.memoryDir, 'long');
    this.logsDir = path.join(this.memoryDir, 'logs');
    this.configPath = path.join(this.mindDir, 'config.yml');
    this.lockDir = path.join(this.mindDir, '.lock');
    this.resolved = true;
  }

  private async listMarkdownFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  private async countMarkdownFiles(directory: string): Promise<number> {
    const files = await this.listMarkdownFiles(directory);
    return files.length;
  }

  private async readMemoryFile(filePath: string): Promise<ParsedMemoryFile> {
    const rawContent = await readFile(filePath, 'utf8');
    const parsed = this.parseMemoryDocument(rawContent);

    if (this.isValidTimestamp(parsed.frontmatter.updated)) {
      return parsed;
    }

    const fileStat = await stat(filePath);
    return {
      ...parsed,
      frontmatter: {
        summary: parsed.frontmatter.summary,
        updated: fileStat.mtime.toISOString(),
      },
    };
  }

  private parseMemoryDocument(rawContent: string): ParsedMemoryFile {
    const frontmatterMatch = rawContent.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

    if (!frontmatterMatch) {
      return {
        frontmatter: { summary: '', updated: '' },
        body: rawContent,
        rawContent,
      };
    }

    const [, frontmatterBlock, body] = frontmatterMatch;
    return {
      frontmatter: this.parseFrontmatter(frontmatterBlock),
      body,
      rawContent,
    };
  }

  private parseFrontmatter(frontmatterBlock: string): FrontmatterData {
    const lines = frontmatterBlock.split('\n');
    let summary = '';
    let updated = '';

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';

      if (line.startsWith('summary:')) {
        const value = line.slice('summary:'.length).trim();

        if (value === '>-' || value === '>' || value === '|' || value === '|-') {
          const blockLines: string[] = [];

          for (index += 1; index < lines.length; index += 1) {
            const blockLine = lines[index] ?? '';

            if (blockLine.startsWith('  ')) {
              blockLines.push(blockLine.slice(2));
              continue;
            }

            if (blockLine === '') {
              blockLines.push('');
              continue;
            }

            index -= 1;
            break;
          }

          summary = value.startsWith('>') ? this.foldYamlBlock(blockLines) : blockLines.join('\n');
          continue;
        }

        summary = this.parseYamlScalar(value);
        continue;
      }

      if (line.startsWith('updated:')) {
        updated = this.parseYamlScalar(line.slice('updated:'.length).trim());
      }
    }

    return { summary, updated };
  }

  private foldYamlBlock(lines: string[]): string {
    let result = '';
    let previousBlank = false;

    for (const line of lines) {
      if (line === '') {
        result += result.endsWith('\n') || result.length === 0 ? '' : '\n';
        previousBlank = true;
        continue;
      }

      if (result.length > 0 && !previousBlank) {
        result += ' ';
      }

      result += line;
      previousBlank = false;
    }

    return result;
  }

  private parseYamlScalar(value: string): string {
    if (value.length === 0) {
      return '';
    }

    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        return JSON.parse(value) as string;
      } catch {
        return value.slice(1, -1);
      }
    }

    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1).replace(/''/g, "'");
    }

    return value;
  }

  private serializeMemoryDocument(frontmatter: FrontmatterData, body: string): string {
    const summaryLines = this.serializeSummary(frontmatter.summary);
    const bodyContent = body;

    return ['---', ...summaryLines, `updated: ${JSON.stringify(frontmatter.updated)}`, '---', bodyContent].join(
      '\n',
    );
  }

  private serializeSummary(summary: string): string[] {
    if (summary.length === 0) {
      return ['summary: ""'];
    }

    if (summary.includes('\n')) {
      return ['summary: >-', ...summary.split('\n').map((line) => `  ${line}`)];
    }

    return [`summary: ${JSON.stringify(summary)}`];
  }

  private async readJsonl(filePath: string): Promise<LogEntry[]> {
    if (!(await this.pathExists(filePath))) {
      return [];
    }

    const raw = await readFile(filePath, 'utf8');

    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as Partial<LogEntry>;

          if (
            typeof parsed.id === 'number' &&
            typeof parsed.summary === 'string' &&
            typeof parsed.context === 'string' &&
            typeof parsed.interaction === 'string'
          ) {
            return [parsed as LogEntry];
          }

          return [];
        } catch {
          return [];
        }
      });
  }

  private topicPath(location: MemoryLocation, topic: string): string {
    return path.join(this.directoryFor(location), `${topic}.md`);
  }

  private logPath(topic: string): string {
    return path.join(this.logsDir, `${topic}.jsonl`);
  }

  private directoryFor(location: MemoryLocation): string {
    return location === 'short' ? this.shortDir : this.longDir;
  }

  private normalizeTopic(topic: string): string {
    const trimmed = topic.trim();

    if (trimmed.length === 0) {
      throw new Error('Topic must not be empty');
    }

    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
      throw new Error('Topic must be a single filename-safe segment');
    }

    if (trimmed === '.' || trimmed === '..') {
      throw new Error('Topic must not be a relative path segment');
    }

    return trimmed;
  }

  private defaultConfig(): MemoryConfig {
    return {
      memory: {
        short_term: {
          limit: DEFAULT_CONFIG.memory.short_term.limit,
        },
        long_term: {
          page_size: DEFAULT_CONFIG.memory.long_term.page_size,
        },
      },
    };
  }

  private readConfigInteger(
    lines: string[],
    section: 'short_term' | 'long_term',
    key: 'limit' | 'page_size',
    fallback: number,
  ): number {
    let inMemorySection = false;
    let inTargetSection = false;
    const sectionLine = `  ${section}:`;
    const keyPrefix = `    ${key}:`;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        continue;
      }

      if (!inMemorySection) {
        if (line === 'memory:') {
          inMemorySection = true;
        }

        continue;
      }

      if (!line.startsWith('  ')) {
        break;
      }

      if (line === sectionLine) {
        inTargetSection = true;
        continue;
      }

      if (!line.startsWith('    ')) {
        inTargetSection = false;
        continue;
      }

      if (!inTargetSection || !line.startsWith(keyPrefix)) {
        continue;
      }

      const parsed = Number.parseInt(line.slice(keyPrefix.length).trim(), 10);
      return this.readPositiveInteger(parsed, fallback);
    }

    return fallback;
  }

  private readPositiveInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await stat(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private isAlreadyExistsError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code === 'EEXIST'
    );
  }

  private isValidTimestamp(value: string): boolean {
    return Number.isFinite(Date.parse(value));
  }

  private parseTimestamp(value: string): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private async sleep(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
