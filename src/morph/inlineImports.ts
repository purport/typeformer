import { FileUtils, StandardizedFilePath } from "@ts-morph/common";
import assert from "assert";
import { ImportDeclarationStructure, OptionalKind, Project, SourceFile, ts } from "ts-morph";

import {
    filenameIsNamespaceBarrel,
    formatImports,
    getTsSourceFiles,
    getTsStyleRelativePath,
    isNamespaceBarrel,
    log,
} from "./utilities.js";

export function inlineImports(project: Project): void {
    const fs = project.getFileSystem();
    const checker = project.getTypeChecker().compilerObject;

    log("removing namespace uses");
    for (const sourceFile of getTsSourceFiles(project)) {
        console.log(sourceFile.getBaseNameWithoutExtension());
        if (isNamespaceBarrel(sourceFile)) {
            continue;
        }

        // These structures are written to be easy to check by localName, not by specifier.
        // We reorganize them later.

        // localName -> moduleSpecifier
        const starImports = new Map<string, string>();

        // localName -> { moduleSpecifier, foreignName }
        const namedImports = new Map<string, { moduleSpecifier: string; foreignName: string }>();

        function filenameToSpecifier(filename: string): string {
            return getTsStyleRelativePath(
                sourceFile.getFilePath(),
                FileUtils.getStandardizedAbsolutePath(fs, filename),
            ).replace(/(\.d)?\.ts$/, "");
        }

        function tryAddStarImport(filename: string, localName: string): boolean {
            const moduleSpecifier = filenameToSpecifier(filename);
            if (namedImports.has(localName)) {
                return false;
            }

            const existing = starImports.get(localName);
            if (existing) {
                return existing === moduleSpecifier;
            }

            starImports.set(localName, moduleSpecifier);
            return true;
        }

        function tryAddNamedImport(filename: string, localName: string, foreignName: string): boolean {
            const moduleSpecifier = filenameToSpecifier(filename);
            if (starImports.has(localName)) {
                return false;
            }

            const existing = namedImports.get(localName);
            if (existing) {
                return existing.moduleSpecifier === moduleSpecifier && existing.foreignName === foreignName;
            }

            namedImports.set(localName, { moduleSpecifier, foreignName });
            return true;
        }

        const nodesToRemove: { remove(): void }[] = [];

        sourceFile.transform((traversal) => {
            const node = traversal.currentNode;

            const replacement = tryReplace(node, traversal.factory);
            if (replacement) {
                if (replacement.nodeToRemove) {
                    nodesToRemove.push(sourceFile._getNodeFromCompilerNode(replacement.nodeToRemove));
                }
                return replacement.node;
            }

            return traversal.visitChildren();
        });

        function tryReplace(
            node: ts.Node,
            factory: ts.NodeFactory,
        ): { node: ts.Node; nodeToRemove?: ts.Statement } | undefined {
            if (ts.isImportDeclaration(node)) {
                // Stop recursing by "replacing" this node with itself.
                return { node };
            }

            interface Replacement {
                lhsSymbol: ts.Symbol | undefined; // Symbol for the namespace, e.g. the LHS.
                rhsSymbol: ts.Symbol | undefined; // Symbol to check for shadowing in the current scope. Undefined to skip shadow checking.
                skipShadowCheck?: boolean; // True if we can ignore shadowed names.
                localName: string; // Local name for the incoming symbol.
                foreignName?: string; // Name of the symbol in the namespace, if different than the local name.
                node: ts.Node; // Node to return the the transform's caller; usually the RHS node.
                nodeToRemove?: ts.Statement; // Node to remove if replacement succeeds.
            }

            let replacement: Replacement | undefined;

            if (
                ts.isImportEqualsDeclaration(node) &&
                ts.isQualifiedName(node.moduleReference) &&
                !ts.isModuleBlock(node.parent) // You can't do "export { something }" in a namespace.
            ) {
                let substitute: ts.Node;
                let nodeToRemove: ts.Statement | undefined;

                const localName = ts.idText(node.name);
                if (ts.hasSyntacticModifier(node, ts.ModifierFlags.Export)) {
                    // export import name = ts.foo.bar;
                    //     ->
                    // import { bar as name } from "./_namespaces/ts.foo.ts";
                    // export { name };

                    substitute = factory.createExportDeclaration(
                        undefined,
                        undefined,
                        false,
                        factory.createNamedExports([factory.createExportSpecifier(false, undefined, localName)]),
                    );
                } else {
                    // import name = ts.foo.bar;
                    //     ->
                    // import { bar as name } from "./_namespaces/ts.foo.ts";

                    // We can't return `undefined` in ts-morph's transform API, so just leave as-is and remove later.
                    substitute = node;
                    nodeToRemove = node;
                }

                replacement = {
                    lhsSymbol: checker.getSymbolAtLocation(node.moduleReference.left),
                    rhsSymbol: checker.getSymbolAtLocation(node.moduleReference.right),
                    skipShadowCheck: true,
                    localName,
                    foreignName: ts.idText(node.moduleReference.right),
                    node: substitute,
                    nodeToRemove,
                };
            } else if (ts.isQualifiedName(node)) {
                if (ts.isImportEqualsDeclaration(node.parent) && node.parent.moduleReference === node) {
                    // We're the RHS of a "import name = ts.foo.bar;". If the above step didn't work,
                    // we shouldn't try to replace anything in the assignment as this will just break it.
                    // So, stop recursing.
                    return { node };
                }

                // Qualified names, i.e. a dotted name in type space.
                //
                // const x: ts.foo.bar;
                //     ->
                // import { bar } from "./_namespaces/ts.foo.ts";
                // const x: bar;

                replacement = {
                    lhsSymbol: checker.getSymbolAtLocation(node.left),
                    rhsSymbol: checker.getSymbolAtLocation(node.right),
                    localName: ts.idText(node.right),
                    node: node.right,
                };
            } else if (
                ts.isPropertyAccessExpression(node) &&
                (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression)) &&
                !ts.isPrivateIdentifier(node.name)
            ) {
                // Property access, i.e. a dotted name in expression space.
                //
                // ts.foo.bar();
                //     ->
                // import { bar } from "./_namespaces/ts.foo.ts";
                // bar();

                replacement = {
                    lhsSymbol: checker.getSymbolAtLocation(node.expression),
                    rhsSymbol: checker.getSymbolAtLocation(node.name),
                    localName: ts.idText(node.name),
                    node: node.name,
                };
            }

            if (!replacement || !replacement.lhsSymbol || !replacement.rhsSymbol) {
                return undefined;
            }

            replacement.lhsSymbol = ts.skipAlias(replacement.lhsSymbol, checker);
            replacement.rhsSymbol = ts.skipAlias(replacement.rhsSymbol, checker);

            const maybeNamespaceBarrel = replacement.lhsSymbol.valueDeclaration;
            if (
                !maybeNamespaceBarrel ||
                !ts.isSourceFile(maybeNamespaceBarrel) ||
                maybeNamespaceBarrel.isDeclarationFile
            ) {
                return undefined;
            }

            const foundSymbol = !replacement.skipShadowCheck
                ? findSymbolInScope(checker, replacement.localName, replacement.rhsSymbol, node)
                : undefined;

            // Name resolved to something; if this is the symbol we're looking for, use it directly.
            if (foundSymbol) {
                if (foundSymbol === replacement.rhsSymbol) {
                    return replacement;
                }
                // Otherwise, we'd shadow, so don't replace.
                return undefined;
            }

            // We didn't find any variable that shadows this use; try importing.

            // Try to write:
            //
            //     import * as performance from "./_namespaces/ts.performance.ts
            //
            // Instead of writing the less-cool:
            //
            //     import { performance } from "./_namespaces/ts.ts"
            //
            const rhsDecl = replacement.rhsSymbol.valueDeclaration;
            if (
                rhsDecl &&
                ts.isSourceFile(rhsDecl) &&
                filenameIsNamespaceBarrel(rhsDecl.fileName) &&
                !replacement.foreignName &&
                !shouldKeepExplicit(
                    sourceFile.getFilePath(),
                    FileUtils.getStandardizedAbsolutePath(fs, rhsDecl.fileName),
                )
            ) {
                // TODO: we need to special case all of the things that were already explicit
                // before the explicitify step.
                if (tryAddStarImport(rhsDecl.fileName, replacement.localName)) {
                    return replacement;
                }
            }

            // Try writing:
            //
            //     import { bar } from "./_namespaces/ts.foo.ts"
            const lhsDecl = replacement.lhsSymbol.valueDeclaration;
            if (
                lhsDecl &&
                ts.isSourceFile(lhsDecl) &&
                filenameIsNamespaceBarrel(lhsDecl.fileName) &&
                !shouldKeepExplicit(
                    sourceFile.getFilePath(),
                    FileUtils.getStandardizedAbsolutePath(fs, lhsDecl.fileName),
                )
            ) {
                // TODO: we need to special case all of the things that were already explicit
                // before the explicitify step.
                if (
                    tryAddNamedImport(
                        lhsDecl.fileName,
                        replacement.localName,
                        replacement.foreignName ?? replacement.localName,
                    )
                ) {
                    return replacement;
                }
            }

            return undefined;
        }

        for (const node of nodesToRemove) {
            node.remove();
        }

        // TODO: can we place these imports right next to the existing namespace imports, rather than at the bottom?
        // If we eliminate unused imports, the ordering will change, which is not good. Or, write our own import organizer,
        // but that's probably slow within ts-morph.

        const newImports = new Map</*moduleSpecifier*/ string, { localName: string; foreignName: string }[]>();
        namedImports.forEach(({ moduleSpecifier, foreignName }, localName) => {
            let arr = newImports.get(moduleSpecifier);
            if (!arr) {
                arr = [];
                newImports.set(moduleSpecifier, arr);
            }
            arr.push({ localName, foreignName });
        });

        const imports: OptionalKind<ImportDeclarationStructure>[] = [];

        starImports.forEach((moduleSpecifier, localName) => {
            imports.push({
                namespaceImport: localName,
                moduleSpecifier,
            });
        });

        newImports.forEach((namedImports, moduleSpecifier) => {
            imports.push({
                namedImports: namedImports.map(({ localName, foreignName }) => {
                    if (localName === foreignName) {
                        return {
                            name: localName,
                        };
                    } else {
                        return {
                            name: foreignName,
                            alias: localName,
                        };
                    }
                }),
                moduleSpecifier,
            });
        });

        // TODO: this inserts them on the top, when they should be going underneath the existing imports.
        // Is it safe to just find the index of the last import declaration?
        // sourceFile.insertImportDeclarations(0, imports);

        const exitingImports = sourceFile.getImportDeclarations();
        let insertIndex = 0;
        if (exitingImports.length > 0) {
            const last = exitingImports[exitingImports.length - 1];
            insertIndex = last.getChildIndex() + 1;
        }
        sourceFile.insertImportDeclarations(insertIndex, imports);
    }

    log("cleaning up imports");
    for (const sourceFile of getTsSourceFiles(project)) {
        if (isNamespaceBarrel(sourceFile)) {
            continue;
        }
        formatImports(sourceFile);
    }
}

// These are names which are already declared in the global scope, but TS
// has redeclared one way or another. If we don't allow these to be shadowed,
// we end up with ts.Symbol, ts.Node, ts.Set, etc, all over the codebase.
const redeclaredGlobals = new Set([
    "Symbol",
    "Node",
    "Map",
    "MapConstructor",
    "ReadonlyMap",
    "Set",
    "SetConstructor",
    "ReadonlySet",
    "Iterator",
]);

function findSymbolInScope(
    checker: ts.TypeChecker,
    name: string,
    s: ts.Symbol,
    location: ts.Node,
): ts.Symbol | undefined {
    // s = ts.skipAlias(s, checker);

    let meaning = ts.SymbolFlags.Namespace;
    if (s.flags & ts.SymbolFlags.Value) {
        meaning |= ts.SymbolFlags.Value;
    }
    if (s.flags & ts.SymbolFlags.Type) {
        meaning |= ts.SymbolFlags.Type;
    }

    const shouldExcludeGlobals = redeclaredGlobals.has(name);
    return checker.resolveName(name, location, meaning, shouldExcludeGlobals);
}

interface Testable {
    test(s: string): boolean;
}

function not(t: Testable): Testable {
    return {
        test: (s) => !t.test(s),
    };
}

function and(...ts: Testable[]): Testable {
    return {
        test: (s) => {
            for (const t of ts) {
                if (!t.test(s)) {
                    return false;
                }
            }
            return true;
        },
    };
}

function or(...ts: Testable[]): Testable {
    return {
        test: (s) => {
            for (const t of ts) {
                if (t.test(s)) {
                    return true;
                }
            }
            return false;
        },
    };
}

type ExplicitRules = [
    currentSourceFileTest: Testable | true,
    namespaceFileTest: Testable | true,
    keepExplicit: boolean,
];

// This is a best-effort set of rules to replicate which files explicitly
// access which namespaces.
//
// This is truly outrageous and we should really consider fixing this mess
// in the final codebase.
//
// TODO: we should be able to simplify the currentSourceFileTests by checking
// which namespace barrel each file is exported through, but doing so breaks
// ts-morph.
// TODO: this doesn't help when a file does a partially-explicit access. We need
// the RHS/LHS checks for that (deleted in WIP).
const explicitRules: ExplicitRules[] = [
    [true, /ts\.performance\.ts/, true],
    [true, /ts\.moduleSpecifiers\.ts/, true],
    [not(/formatting/), /ts\.formatting\.ts/, true],
    [true, /ts\.textChanges\.ts/, true],
    [not(/refactor/), /ts\.refactor\.ts/, true],
    [not(/codefix/), /ts\.codefix\.ts/, true],
    [not(/goToDefinition/), /ts\.GoToDefinition\.ts/, true],
    [not(/findAllReferences/), /ts\.FindAllReferences\.ts/, true],
    [true, /ts\.OrganizeImports\.ts/, true],
    [true, /ts\.SignatureHelp\.ts/, true],
    [true, /ts\.JsDoc\.ts/, true],
    [true, /ts\.SymbolDisplay\.ts/, true],
    [true, /ts\.Rename\.ts/, true],
    [true, /ts\.BreakpointResolver\.ts/, true],
    [true, /ts\.SmartSelectionRange\.ts/, true],
    [true, /ts\.InlayHints\.ts/, true],
    [true, /ts\.CallHierarchy\.ts/, true],
    [true, /ts\.OutliningElementsCollector\.ts/, true],
    [true, /ts\.classifier\.ts/, true],
    [true, /ts\.classifier\.v2020\.ts/, true],
    [not(/[Cc]ompletions/), /ts\.Completions\.ts/, true],
    [true, /ts\.Completions\.StringCompletions\.ts/, true],
    [true, /ts\.server\.protocol\.ts/, true],
    [true, /vpath\.ts/, true],
    [true, /vfs\.ts/, true],
    [true, /Utils\.ts/, true],
    [true, /collections\.ts/, true],
    [true, /documents\.ts/, true],
    [true, /fakes\.ts/, true],
    [true, /compiler\.ts/, true],
    [true, /project\.ts/, true],
    [true, /FourSlash\.ts/, true],
    [true, /FourSlashInterface\.ts/, true],
    [true, /Harness\.Parallel\.Host\.ts/, true],
    [true, /Playback\.ts/, true],
    [true, /RWC\.ts/, true],
    [true, /JsTyping\./, true],
    [/harness\/client\.ts/, /ts\./, false],
    [/loggedIO/, /ts\./, true],
    [/tsc/, /ts\./, true],
    [/virtualFileSystemWithWatch/, /ts\./, false],
    [/harness/, /ts\./, true],
    [/testRunner\/unittests/, /ts\./, true],
    [/testRunner\/unittests/, /evaluator\.ts/, true],
    [/testRunner/, /ts\./, true],
    [
        /testRunner\/(compilerRunner|externalCompileRunner|fourslashRunner|runner|test262Runner)/,
        /Harness\.Parallel/,
        true,
    ],
    [/testRunner\/(compilerRunner|externalCompileRunner|fourslashRunner|runner|test262Runner)/, /Harness/, false],
    [/testRunner\/parallel/, /Harness/, false],
    [not(/harness/), /Harness/, true],
    [
        and(
            /harness/,
            or(
                /fakesHosts/,
                /evaluatorImpl/,
                /documentsUtil/,
                /fourslashImpl/,
                /compilerImpl/,
                /harnessUtils/,
                /vfsUtil/,
                /virtualFileSystemWithWatch/,
            ),
        ),
        /Harness/,
        true,
    ],
];

function shouldKeepExplicit(sourceFilePath: StandardizedFilePath, namespaceFilePath: StandardizedFilePath): boolean {
    for (const [currentSourceFileTest, namespaceFileTest, keepExplicit] of explicitRules) {
        const a = currentSourceFileTest === true || currentSourceFileTest.test(sourceFilePath);
        const b = namespaceFileTest === true || namespaceFileTest.test(namespaceFilePath);
        if (a && b) {
            return keepExplicit;
        }
    }

    return false;
}
