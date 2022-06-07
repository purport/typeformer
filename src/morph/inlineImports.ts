import { FileUtils } from "@ts-morph/common";
import { ImportDeclarationStructure, OptionalKind, Project, ts } from "ts-morph";

import {
    formatImports,
    getTsSourceFiles,
    getTsStyleRelativePath,
    isNamespaceBarrel,
    log,
    namespacesDirName,
} from "./utilities.js";

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
            factory: ts.NodeFactory
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
                        factory.createNamedExports([factory.createExportSpecifier(false, undefined, localName)])
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

            // Name didn't resolve; see if the LHS is a namespace barrel and try to import from it.
            const barrelDecl = replacement.lhsSymbol.valueDeclaration;
            if (barrelDecl && ts.isSourceFile(barrelDecl) && barrelDecl.fileName.includes(namespacesDirName)) {
                // TODO: if rhsSymbol matches this same check, we are about to write:
                //
                //     import { performance } from "./_namespaces/ts.ts"
                //
                // When we should probably write:
                //
                //     import * as performance from "./_namespaces/ts.performance.ts
                //
                // Moreover, we need to special case all of the namespaces the TS codebase canonically writes
                // fully-qualified, e.g. `ts.performance`, the `protocol` namespace, and many more in `Harness`.
                // This info was lost during explicitify, when we made everything fully-qualified.

                const newPath = getTsStyleRelativePath(
                    sourceFile.getFilePath(),
                    FileUtils.getStandardizedAbsolutePath(fs, barrelDecl.fileName)
                );

                if (
                    tryAddImport(
                        newPath.replace(/(\.d)?\.ts$/, ""),
                        replacement.foreignName ?? replacement.localName,
                        replacement.localName
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

        // We don't actually need to be very smart here about prioritizing specific names; the TS codebase
        // doesn't seem to have too many of these cases, solving them by having some "canonical" namespaces
        // which are always fully qualified, like `protocol` or `performance`.
        function tryAddImport(specifier: string, foreignName: string, localName: string) {
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

function findSymbolInScope(
    checker: ts.TypeChecker,
    name: string,
    s: ts.Symbol,
    location: ts.Node
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
