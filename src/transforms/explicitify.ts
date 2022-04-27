import * as ts from "typescript";
import { Node, Symbol } from "typescript";

export function getExplicitifyTransformFactoryFactory() {
    return getExplicitifyTransformFactory;
}

function getExplicitifyTransformFactory(checker: ts.TypeChecker) {
    return explicitifyTransformFactory;
    function explicitifyTransformFactory(context: ts.TransformationContext) {
        let sourceFile: ts.SourceFile;
        return transformSourceFile;

        function transformSourceFile(node: ts.SourceFile) {
            sourceFile = node;
            return ts.visitEachChild(node, visitChildren, context);
        }

        function isSomeDeclarationInLexicalScope(sym: Symbol, location: Node) {
            return sym.declarations?.every(d => { // if _any_ declaration isn't in scope, pessimistically make explicit
                // VariableDeclaration -> VariableDeclarationList -> VariableStatement -> containing declaration
                const container = ts.isVariableDeclaration(d) ? d.parent.parent.parent : d.parent;
                let loc: Node | undefined = location;
                while (loc = loc.parent) {
                    if (loc === container) {
                        return true;
                    }
                }
                return false;
            });
        }

        function visitChildren<T extends Node>(node: T): ts.VisitResult<T> {
            // Skip the `M` in `import("mod").M.N` - it's already fully qualified
            if (ts.isImportTypeNode(node)) {
                const ta = ts.visitNodes(node.typeArguments, visitChildren);
                if (node.typeArguments !== ta) {
                    return ts.updateImportTypeNode(node, node.argument, node.qualifier, ta, node.isTypeOf) as Node as ts.VisitResult<T>;
                }
                return node;
            }
            // We narrow the identifiers we check down to just those which aren't the name of
            // a declaration and aren't the RHS of a property access or qualified name
            if (ts.isIdentifier(node)
                && ts.getNameOfDeclaration(node.parent as ts.Declaration) !== node
                && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
                && !(ts.isQualifiedName(node.parent) && node.parent.right === node)) {
                const sym = checker.getSymbolAtLocation(node);
                const parent = sym && (sym as {parent?: Symbol}).parent;
                if (parent && parent.declarations && parent.declarations.length
                    && parent.declarations.some(ts.isModuleDeclaration)
                    && !isSomeDeclarationInLexicalScope(sym, node)) {
                    const newName = checker.symbolToEntityName(sym, ts.SymbolFlags.Namespace, sourceFile, ts.NodeBuilderFlags.UseOnlyExternalAliasing);
                    if (newName && !ts.isIdentifier(newName)) {
                        if (ts.isQualifiedName(node.parent) || ts.isTypeReferenceNode(node.parent) || ts.isTypeQueryNode(node.parent)) {
                            return newName as ts.VisitResult<Node> as ts.VisitResult<T>;
                        }
                        return checker.symbolToExpression(sym, ts.SymbolFlags.Namespace, sourceFile, ts.NodeBuilderFlags.UseOnlyExternalAliasing) as ts.VisitResult<Node> as ts.VisitResult<T>;
                    }
                }
            }
            return ts.visitEachChild(node, visitChildren, context);
        }
    }
}
