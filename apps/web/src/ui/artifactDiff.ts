export type ArtifactDiffBlock = {
  header: string;
  body: string;
};

function stripAnsi(text: string) {
  const oscRegex = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
  const ansiRegex = /(?:\u001b|\u009b)[[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
  return text
    .replace(oscRegex, "")
    .replace(ansiRegex, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

export function extractDiffBlocks(text: string): ArtifactDiffBlock[] {
  const lines = stripAnsi(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: ArtifactDiffBlock[] = [];
  let current: string[] = [];
  let header = "";

  const pushCurrent = () => {
    if (!header || current.length === 0) return;
    blocks.push({
      header,
      body: current.join("\n").trimEnd(),
    });
    current = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimStart();
    if (line.startsWith("diff --git ")) {
      pushCurrent();
      header = line;
      current = [line];
      continue;
    }
    if (!header) continue;
    current.push(rawLine);
  }

  pushCurrent();
  return blocks.slice(0, 8);
}

export function summarizeDiffBlocks(blocks: ArtifactDiffBlock[]) {
  let added = 0;
  let removed = 0;
  for (const block of blocks) {
    for (const line of block.body.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added += 1;
      if (line.startsWith("-")) removed += 1;
    }
  }
  return { files: blocks.length, added, removed };
}
