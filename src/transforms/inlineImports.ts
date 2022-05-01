import * as ts from "byots";
import { Node, Symbol } from "byots";

import { getTSStyleRelativePath } from "./pathUtil";
import { getNamespaceImports, removeUnusedNamespaceImports } from "./removeUnusedNamespaceImports";

export function getInlineImportsTransformFactoryFactory() {
    return getInlineImportsTransformFactory;
}

// TODO:
// - This needs to be way more aggressive
// - Go all the way back to the definition if final symbol is within the same project?
// - Two-pass visitIdentifiers to figure out the "best" replacement, e.g. if two clashing, and one used more, take it instead?

function getInlineImportsTransformFactory(checker: ts.TypeChecker) {
    return inlineImports;
    function inlineImports(context: ts.TransformationContext) {
        return transformSourceFile;
        function transformSourceFile(file: ts.SourceFile) {
            // const imports = getNamespaceImports(file.statements);
            const syntheticImports = new Map<string, Set<string>>();
            const statements = ts.visitNodes(file.statements, visitIdentifiers);
            const newImportStatements: ts.ImportDeclaration[] = [];
            syntheticImports.forEach((importNames, specifier) => {
                let width = "import { ".length;
                function addLineBreak(s: string): boolean {
                    const next = s.length + ", ".length;
                    const add = width + next >= 120;
                    if (add) {
                        width = "    ".length;
                    }
                    width += next;
                    return add;
                }

                newImportStatements.push(
                    ts.createImportDeclaration(
                        /*decorators*/ undefined,
                        /*modifiers*/ undefined,
                        ts.createImportClause(
                            /*defaultName*/ undefined,
                            ts.setStartsOnNewLine(
                                ts.createNamedImports(
                                    Array.from(importNames.values()).map((s) =>
                                        ts.setStartsOnNewLine(
                                            ts.createImportSpecifier(
                                                /*isTypeOnly*/ false,
                                                /*propertyName*/ undefined,
                                                ts.createIdentifier(s)
                                            ),
                                            addLineBreak(s)
                                        )
                                    )
                                ),
                                /*newLine*/ true
                            )
                        ),
                        ts.createLiteral(specifier)
                    )
                );
            });
            const minimizedStatements = ts.setTextRange(
                ts.createNodeArray(removeUnusedNamespaceImports([...newImportStatements, ...statements], true)),
                file.statements
            );
            return ts.updateSourceFileNode(file, minimizedStatements);

            function visitIdentifiers(node: Node): ts.VisitResult<Node> {
                if (ts.isImportDeclaration(node)) {
                    return node;
                }
                let s: Symbol | undefined;
                let rhsName: string | undefined;
                let possibleSubstitute: ts.Identifier | undefined;
                if (ts.isQualifiedName(node)) {
                    if (ts.isImportEqualsDeclaration(node.parent) && node.parent.moduleReference === node) {
                        return node; // Can't elide the namespace part of an import assignment
                    }
                    // s = checker.getSymbolAtLocation(isQualifiedName(node.left) ? node.left.right : node.left);
                    s = checker.getSymbolAtLocation(node);
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
                    s = checker.getSymbolAtLocation(node);
                    rhsName = ts.idText(node.name);
                    possibleSubstitute = node.name;
                }
                if (s && rhsName && possibleSubstitute) {
                    // This is very TS-specific, but we exclude globals from the lookup if we're resolving `Symbol` or `Node`
                    // so we exclude the global `Symbol` and `Node` - we don't use them, and always expect our own local
                    // `Symbol` and `Node`, instead. We want to be capable of inlining them we they don't force us to keep
                    // `ts.Symbol` and the `import * as ts` import around.
                    const shouldExcludeGlobals = ["Symbol", "Node", "Map", "Set"].includes(rhsName);
                    const bareName = checker.resolveName(
                        rhsName,
                        node,
                        ts.SymbolFlags.Type | ts.SymbolFlags.Value | ts.SymbolFlags.Namespace,
                        shouldExcludeGlobals
                    );
                    if (!bareName) {
                        // Only attempt to inline ns if the thing we're inlining to doesn't currently resolve (globals are OK, we'll over)
                        // const matchingImport = imports.find(i => checker.getSymbolAtLocation(i.importClause.namedBindings.name) === s);
                        // if (matchingImport && addSyntheticImport((matchingImport.moduleSpecifier as StringLiteral).text, rhsName)) {
                        //     return possibleSubstitute;
                        // }
                        // if (!matchingImport && s.flags & SymbolFlags.Alias) {
                        //     const aliasTarget = checker.getAliasedSymbol(s);
                        //     const otherFile = aliasTarget.declarations?.find(d => isSourceFile(d) && !d.isDeclarationFile) as SourceFile | undefined;
                        //     if (otherFile && addSyntheticImport(getTSStyleRelativePath(file.fileName, otherFile.fileName).replace(/(\.d)?\.ts$/, ""), rhsName)) {
                        //         return possibleSubstitute;
                        //     }
                        // }

                        const declPaths = s.declarations
                            ?.filter((d) => {
                                const otherFile = d.getSourceFile();
                                if (otherFile === file || otherFile.isDeclarationFile) {
                                    return false;
                                }

                                const moduleSymbol = otherFile.symbol;
                                if (!(moduleSymbol.flags & ts.SymbolFlags.Module)) {
                                    return false;
                                }

                                return (
                                    moduleSymbol.exports && ts.forEachEntry(moduleSymbol.exports, (s) => s === d.symbol)
                                );
                            })
                            .map((d) => getTSStyleRelativePath(file.fileName, d.getSourceFile().fileName))
                            .sort();
                        const newPath = declPaths?.[0];

                        if (newPath && addSyntheticImport(newPath.replace(/(\.d)?\.ts$/, ""), rhsName)) {
                            return possibleSubstitute;
                        }
                    }
                }
                return ts.visitEachChild(node, visitIdentifiers, context);
            }

            function addSyntheticImport(specifier: string, importName: string) {
                if (
                    Array.from(syntheticImports.entries()).some(
                        ([spec, set]) => spec !== specifier && set.has(importName)
                    )
                ) {
                    // Import name already taken by a different import - gotta leave the second instance explicit
                    return false;
                }
                const synthMap = syntheticImports.get(specifier) || new Set();
                syntheticImports.set(specifier, synthMap);
                synthMap.add(importName);
                return true;
            }
        }
    }
}
