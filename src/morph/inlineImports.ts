import { FileUtils } from "@ts-morph/common";
import { ImportDeclarationStructure, OptionalKind, Project, ts } from "ts-morph";

import { formatImports, getTsSourceFiles, getTsStyleRelativePath, log } from "./utilities";

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
        const syntheticImports = new Map<string, Set<string>>();

        sourceFile.transform((traversal) => {
            const node = traversal.currentNode;
            if (ts.isImportDeclaration(node)) {
                return node;
            }

            let s: ts.Symbol | undefined;
            let rhsName: string | undefined;
            let possibleSubstitute: ts.Identifier | undefined;

            if (ts.isQualifiedName(node)) {
                if (ts.isImportEqualsDeclaration(node.parent) && node.parent.moduleReference === node) {
                    return node; // Can't elide the namespace part of an import assignment
                }
                // s = checker.getSymbolAtLocation(isQualifiedName(node.left) ? node.left.right : node.left);
                s = compilerChecker.getSymbolAtLocation(node);
                rhsName = ts.idText(node.right);
                possibleSubstitute = node.right;
            }
            if (
                ts.isPropertyAccessExpression(node) &&
                (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression)) &&
                !ts.isPrivateIdentifier(node.name)
            ) {
                // technically should handle parenthesis, casts, etc - maybe not needed, though
                // s = checker.getSymbolAtLocation(isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression);
                s = compilerChecker.getSymbolAtLocation(node);
                rhsName = ts.idText(node.name);
                possibleSubstitute = node.name;
            }
            if (s && rhsName && possibleSubstitute) {
                const shouldExcludeGlobals = redeclaredGlobals.has(rhsName);

                // TODO: s = ts.skipAlias(s) ?
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

                const bareName = compilerChecker.resolveName(rhsName, node, flags, shouldExcludeGlobals);
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

                    if (newPath && addSyntheticImport(newPath.replace(/(\.d)?\.ts$/, ""), rhsName)) {
                        return possibleSubstitute;
                    }
                }
            }
            return traversal.visitChildren();
        });

        // TODO: can we be smarter and pick the imports which minimizes the number of leftover namespace uses?
        function addSyntheticImport(specifier: string, importName: string) {
            if (
                Array.from(syntheticImports.entries()).some(([spec, set]) => spec !== specifier && set.has(importName))
            ) {
                // Import name already taken by a different import - gotta leave the second instance explicit
                return false;
            }
            const synthMap = syntheticImports.get(specifier) || new Set();
            syntheticImports.set(specifier, synthMap);
            synthMap.add(importName);
            return true;
        }

        const imports: OptionalKind<ImportDeclarationStructure>[] = [];
        syntheticImports.forEach((importNames, specifier) => {
            imports.push({
                namedImports: Array.from(importNames.values())
                    .sort()
                    .map((s) => ({ name: s })),
                moduleSpecifier: specifier,
            });
        });

        sourceFile.insertImportDeclarations(0, imports);
    }

    // log("organizing imports");
    // for (const sourceFile of getTsSourceFiles(project)) {
    //     if (sourceFile.getFilePath().includes("_namespaces")) {
    //         continue;
    //     }
    //     sourceFile.organizeImports();
    // }

    // This also removes unused imports.
    log("reformatting imports");
    for (const sourceFile of getTsSourceFiles(project)) {
        if (sourceFile.getFilePath().includes("_namespaces")) {
            continue;
        }

        formatImports(sourceFile);
    }
}
