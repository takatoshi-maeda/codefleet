import { describe, expect, it } from 'vitest';

import { findDefaultDocumentFileId } from '../ui/src/components/document/documentDefaultSelection.ts';
import type { DocumentTreeNode } from '../ui/src/components/document/documentTypes.ts';

function file(path: string): DocumentTreeNode {
  const name = path.split('/').at(-1) ?? path;
  return {
    id: path,
    kind: 'file',
    name,
    path,
    language: 'text',
  };
}

function folder(path: string, children: DocumentTreeNode[]): DocumentTreeNode {
  const name = path.split('/').at(-1) ?? path;
  return {
    id: path,
    kind: 'folder',
    name,
    path,
    children,
  };
}

describe('findDefaultDocumentFileId', () => {
  it('prefers the root README when present', () => {
    const tree = [
      folder('docs', [file('docs/guide.md')]),
      file('README.md'),
      file('notes.md'),
    ];

    expect(findDefaultDocumentFileId(tree, new Set(['docs']))).toBe('README.md');
  });

  it('skips files inside collapsed folders when choosing the fallback', () => {
    const tree = [
      folder('a-collapsed', [file('a-collapsed/hidden.md')]),
      folder('b-open', [file('b-open/visible.md')]),
    ];

    expect(findDefaultDocumentFileId(tree, new Set(['a-collapsed']))).toBe('b-open/visible.md');
  });

  it('uses the first visible root file when no README exists', () => {
    const tree = [
      file('notes.md'),
      folder('docs', [file('docs/guide.md')]),
    ];

    expect(findDefaultDocumentFileId(tree, new Set())).toBe('notes.md');
  });
});
