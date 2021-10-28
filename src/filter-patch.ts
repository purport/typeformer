import * as fs from "fs";

const err = (msg: string) => { throw new Error(msg); }

let curDelta = 0;

const doDiffChunk = (chunk: string) => {
    const [header, ...lines] = chunk.split("\n");
    const [_, pfx, srcLine, srcSize = "1", dstLine, dstSize = "1", sfx] =
        header.match(/^(@@ -(\d+)(?:,(\d+))? \+)(\d+)(?:,(\d+))?( @@.*)$/)
        || err(`bad chunk header line: ${header}`);
    // lines.length > 0 && lines.pop() === "" || err("sanity fail");
    lines.pop(); // always ends in "" since chunk ends in LF
    // no-context diffs => all chunks are deletions followed by additions
    // lines.map(l => l[0]).join("").match(/^-*\+*$/) || err("sanity fail");
    let adds = +dstSize;
    if (lines.includes("-\r")) {
        let P = lines.findIndex(x => x.startsWith("+"));
        if (P < 0) P = lines.length;
        // P === +srcSize || err("sanity fail");
        // lines.length-P === +dstSize || err("sanity fail");
        let i = 0;
        while (i < P && lines[i] === "-\r") { i++; lines.splice(P, 0, "+\r"); adds++; }
        if (i < P) {
            i = P - 1; while (lines[i] === "-\r") { i--; lines.push("+\r"); adds++; }
        }
    }
    const newDstRange = (+dstLine + curDelta).toString() + (adds === 1 ? "" : `,${adds}`);
    curDelta += lines.length - +srcSize - +dstSize;
    return pfx + newDstRange + sfx + "\n" + lines.join("\n") + "\n";
};

const doFileChunk = (chunk: string) => {
    curDelta = 0;
    return chunk;
};

const doChunk = (chunk: string) =>
    ((chunk.startsWith("diff") ? doFileChunk
      : chunk.startsWith("@@") ? doDiffChunk
      : (console.error("error: bad chunk, \"%s\"", chunk.slice(0,100)),
         process.exit(1)))
     (chunk));

fs.readFileSync(0, { encoding: "utf-8" })
    .split(/(?=^diff --git|^@@)/m)
    .forEach(c => process.stdout.write(doChunk(c)));
