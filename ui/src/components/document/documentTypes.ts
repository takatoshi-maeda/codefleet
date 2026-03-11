export type DocumentTreeNode = {
  id: string;
  name: string;
  path: string;
  kind: 'file' | 'folder';
  children?: DocumentTreeNode[];
  content?: string;
  language?: 'markdown' | 'python' | 'text' | 'image' | 'video' | 'pdf' | 'binary';
};

export type DocumentReleaseNote = {
  id: string;
  version: string;
  title: string;
  publishedAt: string;
  summary: string;
  linkedFilePath: string;
};

export type DocumentChatMessage = {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: string;
};
