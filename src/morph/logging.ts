const indent = " ".repeat(4);

let currentIndent = "";

export function log(message: string) {
    console.log(`${currentIndent}${message}`);
}

export function indentLog(fn: () => void) {
    const lastIndent = currentIndent;
    try {
        currentIndent += indent;
        fn();
    } finally {
        currentIndent = lastIndent;
    }
}
