import type { DocumentTreeNode } from './documentTypes';

function findFirstVisibleFile(
  nodes: DocumentTreeNode[],
  collapsedFolderIds: ReadonlySet<string>,
): DocumentTreeNode | null {
  for (const node of nodes) {
    if (node.kind === 'file') {
      return node;
    }
    if (collapsedFolderIds.has(node.id)) {
      continue;
    }
    const firstVisibleChildFile = findFirstVisibleFile(node.children ?? [], collapsedFolderIds);
    if (firstVisibleChildFile) {
      return firstVisibleChildFile;
    }
  }
  return null;
}

export function findDefaultDocumentFileId(
  nodes: DocumentTreeNode[],
  collapsedFolderIds: ReadonlySet<string>,
): string | null {
  const rootReadme = nodes.find((node) => node.kind === 'file' && node.path === 'README.md');
  if (rootReadme) {
    return rootReadme.id;
  }

  // Keep the fallback aligned with the explorer's rendered order so a file inside
  // a collapsed folder is never auto-opened.
  return findFirstVisibleFile(nodes, collapsedFolderIds)?.id ?? null;
}
