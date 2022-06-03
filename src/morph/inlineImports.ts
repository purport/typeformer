import { FileUtils } from "@ts-morph/common";
import assert from "assert";
import { FileSystemHost, ImportDeclarationStructure, OptionalKind, Project, SourceFile, Symbol, ts } from "ts-morph";

import { formatImports, getTsSourceFiles, getTsStyleRelativePath, isNamespaceBarrel, log } from "./utilities.js";

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

interface RemovableNode {
    remove(): void;
}

export function inlineImports(project: Project): void {
    const fs = project.getFileSystem();
    const checker = project.getTypeChecker().compilerObject;

    log("removing namespace uses");
    for (const sourceFile of getTsSourceFiles(project)) {
        if (isNamespaceBarrel(sourceFile)) {
            continue;
        }

        const syntheticImports = new Map<string, Map<string, string>>();
        const nodesToRemove: RemovableNode[] = [];

        sourceFile.transform((traversal) => {
            const node = traversal.currentNode;
            if (ts.isImportDeclaration(node)) {
                return node;
            }

            let s: ts.Symbol | undefined; // This is the symbol on the RHS (in the old typeformer, this was the LHS).
            let foreignName: string | undefined; // The name as it's declared in another file.
            let localName: string | undefined; // The name as it's used locally. Usually identical.
            let substituteNode: ts.Node | undefined; // The node to return to the transform caller, usually the RHS (removing the namespace)
            let checkShadowed = true; // True if we should check to see if we're going to shadow first.
            let nodeToRemove: RemovableNode | undefined; // A node to remove if we end up replacing the current node. Needed because ts-morph doesn't let you return undefined.

            // TODO(jakebailey): The below stuff works fine if we want to import everything directly from their
            // declarations, but that seems to cause major execution order problems. I need to rewrite this to
            // be more like the old typeformer, where I check dotted paths biggest to smallest looking for
            // what resolves to a barrel file, then import the rhs from that instead.

            if (
                ts.isImportEqualsDeclaration(node) &&
                ts.isQualifiedName(node.moduleReference) &&
                !ts.isModuleBlock(node.parent) // You can't do "export { something }" in a namespace.
            ) {
                checkShadowed = false;
                s = checker.getSymbolAtLocation(node.moduleReference);
                localName = ts.idText(node.name);
                foreignName = ts.idText(node.moduleReference.right); // TODO: is this right?

                if (ts.hasSyntacticModifier(node, ts.ModifierFlags.Export)) {
                    // export import name = ...;
                    //     ->
                    // import { bar as name } from '...'
                    // export { name };

                    substituteNode = traversal.factory.createExportDeclaration(
                        undefined,
                        undefined,
                        false,
                        traversal.factory.createNamedExports([
                            traversal.factory.createExportSpecifier(false, undefined, localName),
                        ])
                    );
                } else {
                    // import name = ts.Foo.bar;
                    //     ->
                    // import { bar as name } from '...'

                    // We can't return `undefined` in ts-morph's transform API, so just leave as-is and remove later.
                    substituteNode = node;
                    nodeToRemove = sourceFile._getNodeFromCompilerNode(node);
                }
            } else if (ts.isQualifiedName(node)) {
                if (ts.isImportEqualsDeclaration(node.parent) && node.parent.moduleReference === node) {
                    return node; // Can't elide the namespace part of an import assignment
                }
                // s = checker.getSymbolAtLocation(isQualifiedName(node.left) ? node.left.right : node.left);
                s = checker.getSymbolAtLocation(node);
                foreignName = ts.idText(node.right);
                localName = foreignName;
                substituteNode = node.right;
            } else if (
                ts.isPropertyAccessExpression(node) &&
                (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression)) &&
                !ts.isPrivateIdentifier(node.name)
            ) {
                // technically should handle parenthesis, casts, etc - maybe not needed, though
                // s = checker.getSymbolAtLocation(isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression);
                s = checker.getSymbolAtLocation(node);
                foreignName = ts.idText(node.name);
                localName = foreignName;
                substituteNode = node.name;
            }

            if (s) {
                assert(localName);
                assert(foreignName);
                assert(substituteNode);

                const bareName = checkShadowed ? findSymbolInScope(checker, localName, s, node) : undefined;

                if (bareName) {
                    // Name resolved to something; if this is the symbol we're looking for, use it directly.
                    if (bareName === s) {
                        if (nodeToRemove) {
                            nodesToRemove.push(nodeToRemove);
                        }
                        return substituteNode;
                    }
                } else {
                    // Name did not resolve to anything; replace with an import.

                    // const newPath = importDirectly(fs, sourceFile, s);
                    const newPath = importFromBarrel(checker, node.getSourceFile(), s);

                    if (newPath && addSyntheticImport(newPath.replace(/(\.d)?\.ts$/, ""), foreignName, localName)) {
                        if (nodeToRemove) {
                            nodesToRemove.push(nodeToRemove);
                        }
                        return substituteNode;
                    }
                }
            }
            return traversal.visitChildren();
        });

        for (const node of nodesToRemove) {
            node.remove();
        }

        // TODO: can we be smarter and pick the imports which minimizes the number of leftover namespace uses?
        function addSyntheticImport(specifier: string, foreignName: string, localName: string) {
            if (
                Array.from(syntheticImports.entries()).some(([spec, set]) => spec !== specifier && set.has(localName))
            ) {
                // Import name already taken by a different import - gotta leave the second instance explicit
                return false;
            }
            const synthMap = syntheticImports.get(specifier) || new Map();
            syntheticImports.set(specifier, synthMap);
            synthMap.set(localName, foreignName);
            return true;
        }

        const imports: OptionalKind<ImportDeclarationStructure>[] = [];
        syntheticImports.forEach((importNames, specifier) => {
            imports.push({
                namedImports: Array.from(importNames.entries()).map(([localName, foreignName]) => ({
                    name: foreignName,
                    alias: foreignName !== localName ? localName : undefined,
                })),
                moduleSpecifier: specifier,
            });
        });

        sourceFile.insertImportDeclarations(0, imports);
    }

    log("cleaning up imports");
    for (const sourceFile of getTsSourceFiles(project)) {
        if (isNamespaceBarrel(sourceFile)) {
            continue;
        }
        formatImports(sourceFile);
    }
}

function getNamespaceImports(statements: readonly ts.Statement[]) {
    return statements.filter(
        (s) =>
            ts.isImportDeclaration(s) &&
            !!s.importClause &&
            !!s.importClause.namedBindings &&
            ts.isNamespaceImport(s.importClause.namedBindings)
    ) as (ts.ImportDeclaration & { importClause: ts.ImportClause & { namedBindings: ts.NamespaceImport } })[];
}

function importFromBarrel(checker: ts.TypeChecker, sourceFile: ts.SourceFile, s: ts.Symbol): string | undefined {
    const sDecls = s.declarations;
    if (!sDecls) {
        return undefined;
    }

    const namespaceImports = getNamespaceImports(sourceFile.statements);
    for (const i of namespaceImports) {
        const barrelName = i.importClause.namedBindings.name;
        if (barrelName.text !== "ts") {
            // Namespaces other than ts seem to always be fully qualified in the original codebase.
            continue;
        }

        const moduleSymbol = checker.getSymbolAtLocation(i.moduleSpecifier);
        assert(moduleSymbol);
        if (!(moduleSymbol.flags & ts.SymbolFlags.Module)) {
            continue;
        }

        if (checker.getExportsOfModule(moduleSymbol).includes(s)) {
            return (i.moduleSpecifier as ts.StringLiteral).text;
        }
    }

    return undefined;
}

function importDirectly(fs: FileSystemHost, sourceFile: SourceFile, s: ts.Symbol) {
    const declPaths = s.declarations
        ?.filter((d) => {
            const otherFile = d.getSourceFile();
            if (otherFile === sourceFile.compilerNode || otherFile.isDeclarationFile) {
                return false;
            }

            const moduleSymbol = otherFile.symbol;
            if (!(moduleSymbol.flags & ts.SymbolFlags.Module)) {
                return false;
            }

            return moduleSymbol.exports && ts.forEachEntry(moduleSymbol.exports, (s) => s === d.symbol);
        })
        .map((d) =>
            getTsStyleRelativePath(
                sourceFile.getFilePath(),
                FileUtils.getStandardizedAbsolutePath(fs, d.getSourceFile().fileName)
            )
        )
        .sort();

    const newPath = declPaths?.[0];
    if (
        newPath &&
        // Special cases; these were originally written fully-qualified, but we have no idea
        // at this point because the explicitify step made everything explicit. We'll just
        // try and massage these by hand into * imports or something.
        // TODO: Can we do better? Maybe we should make them all direct imports?
        !newPath.endsWith("protocol.ts") &&
        !newPath.endsWith("performance.ts") &&
        !newPath.endsWith("moduleSpecifiers.ts") &&
        !newPath.endsWith("vpathUtil.ts") &&
        !newPath.endsWith("documentsUtil.ts") &&
        !newPath.endsWith("collectionsImpl.ts") &&
        !newPath.endsWith("vfsUtil.ts") &&
        !newPath.endsWith("fakes.ts") &&
        !newPath.endsWith("harnessIO.ts") &&
        !newPath.endsWith("jsTyping.ts") &&
        !newPath.endsWith("fourslashImpl.ts") &&
        !newPath.endsWith("fourslashInterfaceImpl.ts") &&
        !newPath.endsWith("findAllReferences.ts") &&
        !newPath.endsWith("goToDefinition.ts") &&
        !newPath.endsWith("formatting.ts") &&
        !newPath.endsWith("textChanges.ts") &&
        !newPath.endsWith("fakesHosts.ts")
    ) {
        return newPath;
    }

    return undefined;
}

function findSymbolInScope(
    checker: ts.TypeChecker,
    name: string,
    s: ts.Symbol,
    location: ts.Node
): ts.Symbol | undefined {
    s = ts.skipAlias(s, checker);

    let meaning: ts.SymbolFlags = ts.SymbolFlags.Namespace;
    if (s.flags & ts.SymbolFlags.Value) {
        meaning |= ts.SymbolFlags.Value;
    }
    if (s.flags & ts.SymbolFlags.Type) {
        meaning |= ts.SymbolFlags.Type;
    }

    const shouldExcludeGlobals = redeclaredGlobals.has(name);
    return checker.resolveName(name, location, meaning, shouldExcludeGlobals);
}
