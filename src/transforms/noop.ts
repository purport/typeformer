import * as ts from "byots";
import { Node, Symbol } from "byots";

export function getNoopTransformFactoryFactory() {
    return getNoopTransformFactory;
}

function getNoopTransformFactory(checker: ts.TypeChecker) {
    return noopTransformFactory;
    function noopTransformFactory(context: ts.TransformationContext) {
        let sourceFile: ts.SourceFile;
        return transformSourceFile;

        function transformSourceFile(node: ts.SourceFile) {
            sourceFile = node;
            return ts.visitEachChild(node, visitChildren, context);
        }

        function visitChildren<T extends Node>(node: T): ts.VisitResult<T> {
            return ts.visitEachChild(node, visitChildren, context);
        }
    }
}
