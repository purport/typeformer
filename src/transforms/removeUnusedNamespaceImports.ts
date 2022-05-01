import * as ts from "byots";
import { Node, Symbol } from "byots";

/**
 * Heuristically removes unused namespace imports if they obviously have no references left
 * This is not semantic - it just scans the AST for an appropriate identifier that may or
 * may not refer to the namespace import; so this can be easily fooled by variable shadowing.
 * @param statements
 */
export function removeUnusedNamespaceImports(statements: readonly ts.Statement[], debug?: boolean) {
    const imports = getNamespaceImports(statements);
    if (!imports.length) {
        return statements.slice();
    }
    const unusedImports = imports.filter((i) => {
        const name = ts.idText(i.importClause.namedBindings.name);
        return !statements.some((s) => s !== i && containsReferenceTo(name, !!debug)(s));
    });
    return statements.filter((s) => !unusedImports.find((elem) => elem === s));
}

function bindingContainsName(binding: ts.BindingName, name: string): boolean {
    if (ts.isIdentifier(binding)) {
        return name === ts.idText(binding);
    }
    return binding.elements.some((elem) => !ts.isOmittedExpression(elem) && bindingContainsName(elem.name, name));
}

function containsReferenceTo(name: string, debug: boolean) {
    return checkNode;
    function checkNode(n: Node): true | undefined {
        if (ts.isQualifiedName(n)) {
            return checkNode(n.left); // Only check LHS of qualified names
        }
        if (ts.isPropertyAccessExpression(n)) {
            return checkNode(n.expression); // same for property accesses
        }
        if (
            ts.isIdentifier(n) &&
            ts.idText(n) === name &&
            !(n.parent && !ts.isExportSpecifier(n.parent) && ts.getNameOfDeclaration(n.parent as ts.Declaration) === n) // parent points are unreliable unless we're asking about the "original meaning" of the thing
        ) {
            // if (name === "documents" && debug) {
            //     debugger;
            // }
            return true;
        }
        if (ts.isBlock(n) || ts.isModuleBlock(n)) {
            // If a block contains a variable declaration of the name we're looking for, do not descend into that block -
            // that declaration shadows the import
            if (
                n.statements.some(
                    (s) =>
                        ts.isVariableStatement(s) &&
                        s.declarationList.declarations.some((d) => bindingContainsName(d.name, name))
                )
            ) {
                return;
            }
        }
        if (ts.isConstructorDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isArrowFunction(n)) {
            // Likewise, if a function parm is named the same, it shadows the name within that scope
            if (n.parameters.some((p) => bindingContainsName(p.name, name))) {
                return;
            }
        }
        return ts.forEachChild(n, checkNode);
    }
}

export function getNamespaceImports(statements: readonly ts.Statement[]) {
    return statements.filter(
        (s) =>
            ts.isImportDeclaration(s) &&
            !!s.importClause &&
            !!s.importClause.namedBindings &&
            ts.isNamespaceImport(s.importClause.namedBindings)
    ) as (ts.ImportDeclaration & {
        importClause: ts.ImportClause & { namedBindings: ts.NamespaceImport };
    })[];
}
