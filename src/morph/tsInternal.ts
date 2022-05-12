import { ts } from "ts-morph";

export function getNameOfDeclaration(declaration: ts.Declaration | ts.Expression | undefined): ts.Node {
    return (ts as any).getNameOfDeclaration(declaration);
}

export function isInternalDeclaration(node: ts.Node, currentSourceFile: ts.SourceFile): boolean | 0 | undefined {
    return (ts as any).isInterfaceDeclaration(node, currentSourceFile);
}

export function hasSyntacticModifier(node: ts.Node, flags: ts.ModifierFlags): boolean {
    return (ts as any).hasSyntacticModifier(node, flags);
}

export function symbolToString(
    checker: ts.TypeChecker,
    symbol: ts.Symbol,
    enclosingDeclaration?: ts.Node,
    meaning?: ts.SymbolFlags,
    flags?: ts.SymbolFormatFlags
): string {
    return (checker as any).symbolToString(symbol, enclosingDeclaration, meaning, flags);
}
