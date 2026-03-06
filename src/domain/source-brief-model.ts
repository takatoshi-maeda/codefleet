export const DEFAULT_SOURCE_BRIEF_DIR = ".codefleet/data/source-brief";
export const DEFAULT_SOURCE_BRIEF_MARKDOWN_PATH = `${DEFAULT_SOURCE_BRIEF_DIR}/latest.md`;
export const DEFAULT_SOURCE_BRIEF_METADATA_PATH = `${DEFAULT_SOURCE_BRIEF_DIR}/latest.json`;

export interface SourceBriefMetadata {
  version: 1;
  updatedAt: string;
  briefPath: string;
  sourcePaths: string[];
  actorId: string | null;
}

export interface SourceBriefDocument extends SourceBriefMetadata {
  markdown: string;
}

export interface WriteSourceBriefInput {
  markdown: string;
  sourcePaths: string[];
  actorId?: string;
}
