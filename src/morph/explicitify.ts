import { Project, ts } from "ts-morph";

import { getTsSourceFiles } from "./utilities.js";

function isSomeDeclarationInLexicalScope(sym: ts.Symbol, location: ts.Node) {
    return sym.declarations?.every((d) => {
        // if _any_ declaration isn't in scope, pessimistically make explicit
        // VariableDeclaration -> VariableDeclarationList -> VariableStatement -> containing declaration
        const container = ts.isVariableDeclaration(d) ? d.parent.parent.parent : d.parent;
        let loc: ts.Node | undefined = location;
        while ((loc = loc.parent)) {
            if (loc === container) {
                return true;
            }
        }
        return false;
    });
}

export function explicitify(project: Project): void {
    for (const sourceFile of getTsSourceFiles(project)) {
        if (sourceFile.isDeclarationFile()) {
            continue;
        }

        sourceFile.transform((traversal) => {
            const node = traversal.currentNode;
            const checker = project.getTypeChecker().compilerObject;

            // We narrow the identifiers we check down to just those which aren't the name of
            // a declaration and aren't the RHS of a property access or qualified name
            if (
                ts.isIdentifier(node) &&
                ts.getNameOfDeclaration(node.parent as ts.Declaration) !== node &&
                !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
                !(
                    ts.isQualifiedName(node.parent) &&
                    (node.parent.right === node || ts.isImportTypeNode(node.parent.parent))
                )
            ) {
                const sym = checker.getSymbolAtLocation(node);
                const parent = sym && (sym as { parent?: ts.Symbol }).parent;
                if (
                    parent &&
                    parent.declarations &&
                    parent.declarations.length &&
                    parent.declarations.some(ts.isModuleDeclaration) &&
                    !isSomeDeclarationInLexicalScope(sym, node)
                ) {
                    const newName = checker.symbolToEntityName(
                        sym,
                        ts.SymbolFlags.Namespace,
                        sourceFile.compilerNode,
                        ts.NodeBuilderFlags.UseOnlyExternalAliasing
                    );
                    if (newName && !ts.isIdentifier(newName)) {
                        if (
                            ts.isQualifiedName(node.parent) ||
                            ts.isTypeReferenceNode(node.parent) ||
                            ts.isTypeQueryNode(node.parent)
                        ) {
                            return newName;
                        }

                        const exp = checker.symbolToExpression(
                            sym,
                            ts.SymbolFlags.Namespace,
                            sourceFile.compilerNode,
                            ts.NodeBuilderFlags.UseOnlyExternalAliasing
                        );
                        if (exp) {
                            return exp;
                        }
                    }
                }
            }

            return traversal.visitChildren();
        });
    }
}
