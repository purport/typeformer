import { FileUtils } from "@ts-morph/common";
import { ImportDeclarationStructure, OptionalKind, Project, ts } from "ts-morph";

import { getTsSourceFiles, getTsStyleRelativePath, log } from "./utilities";

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
                // This is very TS-specific, but we exclude globals from the lookup if we're resolving `Symbol` or `Node`
                // so we exclude the global `Symbol` and `Node` - we don't use them, and always expect our own local
                // `Symbol` and `Node`, instead. We want to be capable of inlining them we they don't force us to keep
                // `ts.Symbol` and the `import * as ts` import around.
                const shouldExcludeGlobals = ["Symbol", "Node", "Map", "Set"].includes(rhsName);

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

                // TODO: Iterator, ReadonlySet (???), MapConstructor

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

    // TODO: the below steps are very slow; on my machine, 1 minute to organize
    // all imports, and 3 more minutes to do line wrapping. There's definitely
    // a better way to do this, given everyone does these same things on-save
    // in VS Code without trouble.

    log("organizing imports");
    for (const sourceFile of getTsSourceFiles(project)) {
        if (sourceFile.getFilePath().includes("_namespaces")) {
            continue;
        }
        sourceFile.organizeImports();
    }

    log("wrapping long import lines");
    for (const sourceFile of getTsSourceFiles(project)) {
        if (sourceFile.getFilePath().includes("_namespaces")) {
            continue;
        }

        const maxLineLength = 120;
        const indentWidth = 4;

        for (const importDeclaration of sourceFile.getImportDeclarations()) {
            let width = indentWidth; // After formatting, imports will begin on a new indented line.
            function addLineBreak(s: string): boolean {
                const next = s.length + ", ".length;
                const add = width + next >= maxLineLength;
                if (add) {
                    width = indentWidth;
                }
                width += next;
                return add;
            }

            // This doesn't indent properly, but at least gets the code split correctly.
            for (const namedImport of importDeclaration.getNamedImports()) {
                if (addLineBreak(namedImport.getName())) {
                    namedImport.prependWhitespace("\r\n");
                }
            }

            // Fix up broken indent.
            importDeclaration.formatText();
        }
    }
}
