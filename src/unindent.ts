import {
    createPrinter,
    NewLineKind,
    createSourceFile,
    ScriptTarget,
    SyntaxKind,
    Node,
    EmitHint,
    ModuleDeclaration,
    ModuleBlock,
    SyntaxList,
    isModuleDeclaration,
    isModuleBlock,
    isIdentifier,
} from "typescript";
import { existsSync, readFileSync } from "fs";

function unindent(fileName: string) {
    const bad = (msg: string) => new Error(`${fileName}: ${msg}`);
    if (!existsSync(fileName)) throw bad(`file not found`);
    const text = readFileSync(fileName).toString();
    //
    // const onEmitNode = (hint: EmitHint, node: Node, emitCallback: (hint: EmitHint, node: Node) => void) => {
    //     console.error(">>>");
    //     emitCallback(hint, node);
    //     console.error("<<<");
    // };
    const printer = createPrinter({
        removeComments: false, newLine: NewLineKind.CarriageReturnLineFeed //, preserveSourceNewlines: true
    } as any, {
        // onEmitNode
    });
    //
    const sourceFile = createSourceFile(fileName, text, ScriptTarget.ESNext);
    //
    if (sourceFile.getChildCount() !== 2)
        throw bad(`expected 2 toplevel children`);
    if (sourceFile.getChildAt(1).kind !== SyntaxKind.EndOfFileToken)
        throw bad(`expected second toplevel child to be EOF`);
    if (sourceFile.getChildAt(0).kind !== SyntaxKind.SyntaxList)
        throw bad(`expected first toplevel child to be SyntaxList`);
    if (sourceFile.getChildAt(0).getChildCount() !== 1)
        throw bad(`expected first toplevel child to be SyntaxList with one child`);
    const modDecl = sourceFile.getChildAt(0).getChildAt(0);
    if (!isModuleDeclaration(modDecl))
        throw bad(`expected a single toplevel ModuleDeclaration`);
    const modName = modDecl.name;
    if (!isIdentifier(modName))
        throw bad(`expected ModuleDeclaration to have an Identifer name`);
    const modBlock = modDecl.body;
    if (!modBlock)
        throw bad(`expected ModuleDeclaration to have a body`);
    if (!isModuleBlock(modBlock))
        throw bad(`expected ModuleDeclaration to have a ModuleBlock`);
    //
    const texts = modBlock.statements.map(s =>
        printer.printNode(EmitHint.Unspecified, s, sourceFile));
    [`namespace ${modName.escapedText} {`, ``, ...texts, ``, `}`]
    .forEach(line => process.stdout.write(line + "\r\n"));
    // console.log(printer.printFile(sourceFile));
}

if (!process.argv[2]) {
    console.error(`Argument expected`);
    process.exit(1);
}
unindent(process.argv[2]);
