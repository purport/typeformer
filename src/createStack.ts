import assert from "assert";
import { Command, Option } from "clipanion";
import { $, cd, os, question, quiet } from "zx";

import * as zxHacks from "./zxHacks.js";

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
        if (os.platform() === "win32") {
            throw new Error("This script doesn't work on Windows, sorry.");
        }

        zxHacks.setHideOutput(true);

        // Make sure we have the gh tool.
        await quiet($`gh --version`);

        const mergeBase = await getMergeBase();
        const plan = await getPlan(mergeBase);

        console.log();
        console.log("I will:");
        for (const step of plan) {
            console.log(`    cherry-pick "${step.message}" into ${step.branch} and send a PR to ${step.prBase}`);
        }
        console.log();

        const ok = await question("Ready? (y/N) ", {
            choices: ["y", "n"],
        });

        if (ok !== "y") {
            process.exit(1);
        }

        console.log();

        const pwd = process.cwd();
        const worktree = ".git/tmp/stack-worktree";

        for (const step of plan) {
            if (!step.previousBranch) {
                await $`git worktree remove --force ${worktree} || true`;
                await $`git worktree add -B ${step.branch} ${worktree} ${mergeBase}`;
                cd(worktree);
            } else {
                await $`git switch -C ${step.branch} ${step.previousBranch}`;
            }

            await $`git cherry-pick ${step.commit}`;
            await $`git push --force -u origin HEAD`;

            let { stdout: fullMessage } = await $`git show -s --format=%B ${step.commit}`;
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
                await quiet(
                    $`gh pr create -R ${this.repoName} --draft --base ${step.prBase} --head ${step.branch} --title ${step.message} --body ${body}`
                );
            } catch {
                created = false;
                await quiet($`gh pr edit ${step.branch} -R ${this.repoName} --title ${step.message} --body ${body}`);
            }

            const { stdout: prList } = await $`gh pr list -R ${this.repoName} --head ${step.branch} --json url`;
            console.log(`${created ? "Created" : "Updated"} ${JSON.parse(prList)[0].url}`);
        }

        cd(pwd);

        await $`git worktree remove --force ${worktree}`;
    }
}

async function getMergeBase() {
    const { stdout } = await $`git merge-base --all HEAD main`;

    const lines = stdout.trim().split(/\r?\n/);
    assert(lines.length === 1);
    const mergeBase = lines[0].trim();
    assert(mergeBase);
    return mergeBase;
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
    const { stdout } = await $`git log --oneline --reverse ${mergeBase}..HEAD`;

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
                nextBranch: last ? undefined : branchName(humanIndex + 1), // Branch to send PR to
            };
        });

    function branchName(i: number) {
        return `transform-stack-commit-${i}`;
    }
}
