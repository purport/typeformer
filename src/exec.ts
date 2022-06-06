import assert from "assert";
import chalk from "chalk";
import { execa, execaNode, ExecaSyncError } from "execa";
import { quote } from "shell-quote";

export async function runWithOutput(cmd: string, ...args: string[]) {
    printCommand(cmd, args);
    const subprocess = execa(cmd, args);
    subprocess.stdout?.pipe(process.stdout);
    subprocess.stderr?.pipe(process.stderr);

    try {
        return await subprocess;
    } catch (e) {
        // execa's errors include stdout/stderr, but we piped those above.
        // Drop them in favor of a shorter message.
        const execaError = e as Partial<ExecaSyncError>;
        if (execaError.shortMessage) {
            execaError.message = execaError.shortMessage;
        }
        throw e;
    }
}

export function runNoOutput(cmd: string, ...args: string[]) {
    printCommand(cmd, args);
    return execa(cmd, args);
}

export function runHidden(cmd: string, ...args: string[]) {
    return execa(cmd, args);
}

export function runNode(scriptPath: string, ...args: string[]) {
    printCommand("node", [scriptPath, ...args]);
    return execaNode(scriptPath, args);
}

export function cd(path: string) {
    printCommand("cd", [path]);
    process.chdir(path);
}

export async function getMergeBase(run: typeof runWithOutput | typeof runNoOutput) {
    const { stdout } = await run("git", "merge-base", "--all", "HEAD", "main");

    const lines = stdout.trim().split(/\r?\n/);
    assert(lines.length === 1);
    const mergeBase = lines[0].trim();
    assert(mergeBase);
    return mergeBase;
}

function printCommand(cmd: string, args: string[]) {
    console.log(`$ ${chalk.greenBright(cmd)} ${quote(args)}`);
}
