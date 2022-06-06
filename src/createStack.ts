import { Command, Option } from "clipanion";
import * as readline from "readline";
import which from "which";

import { cd, getMergeBase, runHidden, runNoOutput as run } from "./exec.js";

export class CreateStackCommand extends Command {
    static paths = [["create-stack"]];

    static usage = Command.Usage({
        description: "Creates or updates a GitHub PR stack of the current branch.",
    });

    repoName = Option.String("--repo-name", "jakebailey/TypeScript", {
        description: "GitHub repo where PRs will be sent",
        hidden: true,
    });

    async execute() {
        // Make sure we have the gh tool.
        await which("gh");

        const mergeBase = await getMergeBase(run);
        const plan = await getPlan(mergeBase);

        console.log();
        console.log("I will:");
        for (const step of plan) {
            console.log(`    cherry-pick "${step.message}" into ${step.branch} and send a PR to ${step.prBase}`);
        }
        console.log();

        const ok = await question("Ready? (y/N) ");
        if (ok !== "y") {
            process.exit(1);
        }

        console.log();

        const pwd = process.cwd();
        const worktree = ".git/tmp/stack-worktree";

        for (const step of plan) {
            if (!step.previousBranch) {
                try {
                    await run("git", "worktree", "remove", "--force", worktree);
                } catch {
                    // OK
                }
                await run("git", "worktree", "add", "-B", step.branch, worktree, mergeBase);
                cd(worktree);
            } else {
                await run("git", "switch", "-C", step.branch, step.previousBranch);
            }

            await run("git", "cherry-pick", step.commit);
            await run("git", "push", "--force", "-u", "origin", "HEAD");

            let { stdout: fullMessage } = await run("git", "show", "-s", "--format=%B", step.commit);
            fullMessage = fullMessage.replace(/\r/g, "");
            fullMessage = fullMessage.slice(fullMessage.indexOf("\n\n")).trim();

            let body = "";
            if (fullMessage) {
                body += `${fullMessage}\n\n`;
                body += "---\n\n";
            }
            body += "**Please do not comment on this PR**. ";
            body += "Depending on how this set of PRs evolves, ";
            body += "this PR's contents may change entirely based on the order of commits.\n\n";
            body += "This PR is a part of a stack:\n";
            for (const otherStep of plan) {
                if (otherStep === step) {
                    body += `\n  1. ${otherStep.message} (this PR)`;
                } else {
                    body += `\n  1. [${otherStep.message}](https://github.com/${this.repoName}/pull/${otherStep.branch})`;
                }
            }

            let created = true;
            try {
                await runHidden(
                    "gh",
                    "pr",
                    "create",
                    "-R",
                    this.repoName,
                    "--draft",
                    "--base",
                    step.prBase,
                    "--head",
                    step.branch,
                    "--title",
                    step.message,
                    "--body",
                    body
                );
            } catch {
                created = false;
                await runHidden(
                    "gh",
                    "pr",
                    "edit",
                    step.branch,
                    "-R",
                    this.repoName,
                    "--title",
                    step.message,
                    "--body",
                    body
                );
            }

            const { stdout: prList } = await run(
                "gh",
                "pr",
                "list",
                "-R",
                this.repoName,
                "--head",
                step.branch,
                "--json",
                "url"
            );
            console.log(`${created ? "Created" : "Updated"} ${JSON.parse(prList)[0].url}`);
        }

        cd(pwd);

        await run("git", "worktree", "remove", "--force", worktree);
    }
}

interface Step {
    branch: string;
    previousBranch?: string | undefined;
    commit: string;
    prBase: string;
    message: string;
    nextBranch?: string | undefined;
}

async function getPlan(mergeBase: string): Promise<Step[]> {
    const { stdout } = await run("git", "log", "--oneline", "--reverse", `${mergeBase}..HEAD`);

    return stdout
        .trim()
        .split(/\r?\n/)
        .map((s, i, array) => {
            s = s.trim();
            const first = i === 0;
            const last = i === array.length - 1;
            const humanIndex = i + 1;

            const spaceIndex = s.indexOf(" ");
            const commit = s.substring(0, spaceIndex).trim();
            const message = s.substring(spaceIndex + 1).trim();
            return {
                branch: branchName(humanIndex), // Branch to cherry-pick to
                previousBranch: first ? undefined : branchName(humanIndex - 1), // Base to rebase branch to
                commit, // Commit to cherry pick
                prBase: first ? "main" : branchName(humanIndex - 1), // Branch to send PR to
                message, // Message
                nextBranch: last ? undefined : branchName(humanIndex + 1), // Next branch in stack (for linking)
            };
        });

    function branchName(i: number) {
        return `transform-stack-commit-${i}`;
    }
}

function question(query: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(query, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}
