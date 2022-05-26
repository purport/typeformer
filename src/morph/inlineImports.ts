import { FileUtils } from "@ts-morph/common";
import assert from "assert";
import { ImportDeclarationStructure, OptionalKind, Project, Statement, ts } from "ts-morph";

import { formatImports, getTsSourceFiles, getTsStyleRelativePath, isNamespaceBarrel, log } from "./utilities";

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

export function inlineImports(project: Project): void {
    const fs = project.getFileSystem();
    const checker = project.getTypeChecker();
    const compilerChecker = checker.compilerObject;

    log("removing namespace uses");
    for (const sourceFile of getTsSourceFiles(project)) {
        if (isNamespaceBarrel(sourceFile)) {
            continue;
        }

        const syntheticImports = new Map<string, Map<string, string>>();

        const nodesToRemove: Statement[] = [];

        sourceFile.transform((traversal) => {
            const node = traversal.currentNode;
            if (ts.isImportDeclaration(node)) {
                return node;
            }

            let s: ts.Symbol | undefined;
            let foreignName: string | undefined;
            let localName: string | undefined;
            let possibleSubstitute: ts.Node | undefined;
            let checkShadowed = true;

            if (
                ts.isImportEqualsDeclaration(node) &&
                ts.isQualifiedName(node.moduleReference) &&
                !ts.isModuleBlock(node.parent) // You can't do "export { something }" in a namespace.
            ) {
                checkShadowed = false;
                s = compilerChecker.getSymbolAtLocation(node.moduleReference);
                localName = ts.idText(node.name);
                foreignName = ts.idText(node.moduleReference.right); // TODO: is this right?

                if (ts.hasSyntacticModifier(node, ts.ModifierFlags.Export)) {
                    // export import name = ...;
                    //     ->
                    // import { bar as name } from '...'
                    // export { name };

                    possibleSubstitute = traversal.factory.createExportDeclaration(
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
                    possibleSubstitute = node;
                    nodesToRemove.push(sourceFile._getNodeFromCompilerNode(node));
                }
            } else if (ts.isQualifiedName(node)) {
                if (ts.isImportEqualsDeclaration(node.parent) && node.parent.moduleReference === node) {
                    return node; // Can't elide the namespace part of an import assignment
                }
                // s = checker.getSymbolAtLocation(isQualifiedName(node.left) ? node.left.right : node.left);
                s = compilerChecker.getSymbolAtLocation(node);
                foreignName = ts.idText(node.right);
                localName = foreignName;
                possibleSubstitute = node.right;
            } else if (
                ts.isPropertyAccessExpression(node) &&
                (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression)) &&
                !ts.isPrivateIdentifier(node.name)
            ) {
                // technically should handle parenthesis, casts, etc - maybe not needed, though
                // s = checker.getSymbolAtLocation(isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression);
                s = compilerChecker.getSymbolAtLocation(node);
                foreignName = ts.idText(node.name);
                localName = foreignName;
                possibleSubstitute = node.name;
            }

            if (s) {
                assert(localName);
                assert(foreignName);
                assert(possibleSubstitute);

                let bareName: ts.Symbol | undefined;
                if (checkShadowed) {
                    const shouldExcludeGlobals = redeclaredGlobals.has(localName);

                    const sFlags = ts.skipAlias(s, compilerChecker).flags;
                    const isValue = (sFlags & ts.SymbolFlags.Value) !== 0;
                    const isType = (sFlags & ts.SymbolFlags.Type) !== 0;
                    // const isNamespace = (sFlags & ts.SymbolFlags.Namespace) !== 0;

                    let flags: ts.SymbolFlags = ts.SymbolFlags.Namespace; // TODO: can we do better?
                    if (isValue) {
                        flags |= ts.SymbolFlags.Value;
                    }
                    if (isType) {
                        flags |= ts.SymbolFlags.Type;
                    }

                    bareName = compilerChecker.resolveName(localName, node, flags, shouldExcludeGlobals);
                }

                if (bareName) {
                    // Name resolved to something; if this is the symbol we're looking for, use it directly.
                    if (bareName === s) {
                        return possibleSubstitute;
                    }
                } else {
                    // Name did not resolve to anything; replace with an import.
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

                    if (newPath && addSyntheticImport(newPath.replace(/(\.d)?\.ts$/, ""), foreignName, localName)) {
                        return possibleSubstitute;
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
                namedImports: Array.from(importNames.entries())
                    .sort()
                    .map(([localName, foreignName]) => ({
                        name: foreignName,
                        alias: foreignName !== localName ? localName : undefined,
                    })),
                moduleSpecifier: specifier,
            });
        });

        sourceFile.insertImportDeclarations(0, imports);
    }

    // log("organizing imports");
    // for (const sourceFile of getTsSourceFiles(project)) {
    //     if (isNamespaceBarrel(sourceFile)) {
    //         continue;
    //     }
    //     sourceFile.organizeImports();
    // }

    // This also removes unused imports.
    log("reformatting imports");
    for (const sourceFile of getTsSourceFiles(project)) {
        if (isNamespaceBarrel(sourceFile)) {
            continue;
        }
        formatImports(sourceFile);
    }
}
