import * as path from "path";
import { Writable } from "ts-essentials";
import * as ts from "typescript";
import { Node, Symbol } from "typescript";

import { ProjectTransformerConfig } from "..";
import { getTSStyleRelativePath } from "./pathUtil";
import { removeUnusedNamespaceImports } from "./removeUnusedNamespaceImports";

function normalizePath(p: string) {
    const normal = path.normalize(p);
    return ts.sys.useCaseSensitiveFileNames ? normal : normal.toLowerCase();
}

class NormalizedPathMap<T> extends Map<string, T> {
    has(key: string) {
        return super.has(normalizePath(key));
    }
    get(key: string) {
        return super.get(normalizePath(key));
    }
    set(key: string, value: T) {
        return super.set(normalizePath(key), value);
    }
}

class NormalizedPathSet extends Set<string> {
    add(key: string) {
        return super.add(normalizePath(key));
    }
    has(key: string) {
        return super.has(normalizePath(key));
    }
}

export function getStripNamespacesTransformFactoryFactory(config: ProjectTransformerConfig) {
    // TODO: Rather than using a `Set<string>` representing the files that need to be reexported,
    // we may need something more complex where we specify the specific names from that file
    // which should be reexported (to handle things like `namspace a {}` and `namespace b` in the same file)
    // Maps `proj/root/dir/namespace.path.ts` to `Set([file/to/be/reexported])`
    const newNamespaceFiles = new NormalizedPathMap<NormalizedPathSet>();
    const extraFilesFieldMembers = new NormalizedPathMap<NormalizedPathSet>();
    const configDeps = new NormalizedPathMap<NormalizedPathSet>();

    config.onTransformConfigFile = removePrependFromReferencesAndAddNamespacesToFiles;
    config.onTransformComplete = () => {
        // In each project we'll make a ns.ts file in the root (and ns.sub.ts and so on) who's
        // sole role is marshalling reexports into the right shape. In addition to reexporting the
        // local content, it needs to reexport the namespace of the same name from sub-projects
        // (should they contain it)
        return {
            additionalOutputFiles: !newNamespaceFiles.size ? undefined : createSourceFilesForMap(newNamespaceFiles),
        };
    };
    return getStripNamespacesTransformFactory;

    function createSourceFilesForMap(map: typeof newNamespaceFiles) {
        const results: ts.SourceFile[] = [];
        map.forEach((reexports, filename) => {
            const reexportStatements: (ts.ExportDeclaration | ts.ImportDeclaration)[] = [];
            const associatedConfig = [...extraFilesFieldMembers.entries()].find(([_, addedFiles]) =>
                addedFiles.has(filename)
            )![0];
            const dependentPaths = configDeps.get(associatedConfig);
            if (dependentPaths && dependentPaths.size) {
                dependentPaths.forEach((requiredProjectPath) => {
                    const nsFileName = path.join(requiredProjectPath, path.basename(filename));
                    if (newNamespaceFiles.has(nsFileName)) {
                        reexportStatements.push(
                            ts.createExportDeclaration(
                                /*decorators*/ undefined,
                                /*modifiers*/ undefined,
                                /*namedExports*/ undefined,
                                ts.createStringLiteral(
                                    getTSStyleRelativePath(filename, nsFileName).replace(/\.ts$/, "")
                                )
                            )
                        );
                    }
                });
            }
            reexports.forEach((exportingPath) => {
                reexportStatements.push(
                    ts.createExportDeclaration(
                        /*decorators*/ undefined,
                        /*modifiers*/ undefined,
                        /*namedExports*/ undefined,
                        ts.createStringLiteral(getTSStyleRelativePath(filename, exportingPath).replace(/\.ts$/, ""))
                    )
                );
            });
            const partsThis = path
                .basename(filename)
                .slice(0, path.basename(filename).length - path.extname(filename).length)
                .split(".");
            const currentNSName = partsThis.join(".");
            map.forEach((_, otherFilename) => {
                if (otherFilename !== filename && path.dirname(filename) === path.dirname(otherFilename)) {
                    const partsOther = path
                        .basename(otherFilename)
                        .slice(0, path.basename(otherFilename).length - path.extname(otherFilename).length)
                        .split(".");
                    const otherNSParent = partsOther.slice(0, partsOther.length - 1).join(".");
                    if (otherNSParent && otherNSParent === currentNSName) {
                        reexportStatements.push(
                            ts.createImportDeclaration(
                                /*decorators*/ undefined,
                                /*modifiers*/ undefined,
                                ts.createImportClause(
                                    /*name*/ undefined,
                                    ts.createNamespaceImport(ts.createIdentifier(partsOther[partsOther.length - 1]))
                                ),
                                ts.createStringLiteral(
                                    getTSStyleRelativePath(filename, otherFilename).replace(/\.ts$/, "")
                                )
                            )
                        );
                        reexportStatements.push(
                            ts.createExportDeclaration(
                                /*decorators*/ undefined,
                                /*modifiers*/ undefined,
                                ts.createNamedExports([
                                    ts.createExportSpecifier(
                                        /*isTypeOnly*/ false,
                                        /*propertyName*/ undefined,
                                        partsOther[partsOther.length - 1]
                                    ),
                                ])
                            )
                        );
                    }
                }
            });
            const newSource = ts.createNode(ts.SyntaxKind.SourceFile, -1, -1) as Writable<ts.SourceFile>; // There's no SourceFile factory, so this is what we get
            newSource.flags |= ts.NodeFlags.Synthesized;
            newSource.fileName = filename;
            newSource.statements = ts.createNodeArray(reexportStatements);
            newSource.endOfFileToken = ts.createToken(ts.SyntaxKind.EndOfFileToken);
            results.push(newSource);
        });
        return results;
    }

    function removePrependFromReferencesAndAddNamespacesToFiles(context: ts.TransformationContext) {
        let currentSourceFile: ts.SourceFile;
        return transformSourceFile;
        function transformSourceFile(file: ts.SourceFile) {
            currentSourceFile = file;
            const result = ts.visitEachChild(file, visitElement, context);
            // TODO: Fix TS itself so a json source file doesn't present an invalid AST that can't rountdrip thru the factory system without getting extraneous parenthesis added
            if (
                result &&
                ts.isExpressionStatement(result.statements[0]) &&
                ts.isParenthesizedExpression((result.statements[0] as ts.ExpressionStatement).expression)
            ) {
                (result.statements[0] as Writable<ts.ExpressionStatement>).expression = (
                    (result.statements[0] as ts.ExpressionStatement).expression as ts.ParenthesizedExpression
                ).expression;
            }
            return result;
        }

        function visitElement(node: Node): ts.VisitResult<Node> {
            if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) {
                switch (node.name.text) {
                    case "outFile": {
                        const baseDir = path.basename(currentSourceFile.fileName).includes(".release.")
                            ? path
                                  .dirname((node.initializer as ts.StringLiteral).text)
                                  .replace("local", "local/release")
                            : path.dirname((node.initializer as ts.StringLiteral).text);
                        return ts.updatePropertyAssignment(
                            node,
                            ts.createStringLiteral("outDir"),
                            ts.createLiteral(baseDir.replace(/\\/g, "/"))
                        );
                    }
                    case "prepend":
                        return undefined;
                    case "files": {
                        if (
                            ts.isArrayLiteralExpression(node.initializer) &&
                            extraFilesFieldMembers.has(currentSourceFile.fileName)
                        ) {
                            const newFileLiterals: ts.LiteralExpression[] = [];
                            extraFilesFieldMembers.get(currentSourceFile.fileName)!.forEach((filepath) => {
                                newFileLiterals.push(
                                    ts.createLiteral(getTSStyleRelativePath(currentSourceFile.fileName, filepath))
                                );
                            });
                            return ts.updatePropertyAssignment(
                                node,
                                node.name,
                                ts.updateArrayLiteral(node.initializer, [
                                    ...node.initializer.elements,
                                    ...newFileLiterals,
                                ])
                            );
                        }
                    }
                }
            }
            return ts.visitEachChild(node, visitElement, context);
        }
    }

    function getStripNamespacesTransformFactory(checker: ts.TypeChecker, program: ts.Program) {
        const opts = program.getCompilerOptions();
        const configPath = opts.configFilePath!;
        const refs = program.getProjectReferences();
        if (refs) {
            configDeps.set(configPath, new Set(refs.map((r) => r.path)));
        }
        const projRootDir = path.dirname(configPath);
        interface DocumentPosition {
            fileName: string;
            pos: number;
        }
        let sourceMapper:
            | {
                  toLineColumnOffset(
                      fileName: string,
                      position: number
                  ): {
                      /** 0-based. */
                      line: number;
                      /*
                       * 0-based. This value denotes the character position in line and is different from the 'column' because of tab characters.
                       */
                      character: number;
                  };
                  tryGetSourcePosition(info: DocumentPosition): DocumentPosition | undefined;
                  tryGetGeneratedPosition(info: DocumentPosition): DocumentPosition | undefined;
                  clearCache(): void;
              }
            | undefined;
        const getSourceMapper = () =>
            sourceMapper ||
            (sourceMapper = ts.getSourceMapper({
                useCaseSensitiveFileNames() {
                    return ts.sys.useCaseSensitiveFileNames;
                },
                getCurrentDirectory() {
                    return program.getCurrentDirectory();
                },
                getProgram() {
                    return program;
                },
                fileExists: ts.sys.fileExists,
                readFile: ts.sys.readFile,
                log: (_log: string) => void 0,
            }));
        return stripNamespaces;
        function stripNamespaces(context: ts.TransformationContext) {
            const requiredImports = new Set<string>();
            let currentSourceFile: ts.SourceFile;
            return transformSourceFile;
            function transformSourceFile(file: ts.SourceFile) {
                currentSourceFile = file;
                requiredImports.clear();
                const statements = ts.visitNodes(file.statements, visitStatements);
                const result = ts.setTextRange(
                    ts.createNodeArray(removeUnusedNamespaceImports([...getRequiredImports(), ...statements])),
                    file.statements
                );
                // So the output is guaranteed to be a module, if we'd otherwise emit an empty file, emit `export {}`
                // (We'll go back and clean those up later)
                if (result.length === 0 || result.every((n) => n.kind === ts.SyntaxKind.NotEmittedStatement)) {
                    (result as readonly ts.Statement[] as ts.Statement[]).push(
                        ts.createExportDeclaration(
                            /*decorators*/ undefined,
                            /*modifiers*/ undefined,
                            ts.createNamedExports([])
                        )
                    );
                }
                return ts.updateSourceFileNode(file, result);
            }

            function getRequiredImports() {
                const importStatements: ts.Statement[] = [];
                requiredImports.forEach((i) => {
                    const nsFilePath = getTSStyleRelativePath(
                        currentSourceFile.fileName,
                        path.join(projRootDir, `${i}`)
                    );
                    importStatements.push(
                        ts.createImportDeclaration(
                            /*decorators*/ undefined,
                            /*modifiers*/ undefined,
                            ts.createImportClause(/*name*/ undefined, ts.createNamespaceImport(ts.createIdentifier(i))),
                            ts.createLiteral(nsFilePath)
                        )
                    );
                });
                return importStatements;
            }

            function visitIdentifiers<T extends Node>(node: T): T {
                if (
                    ts.isIdentifier(node) &&
                    ts.getNameOfDeclaration(node.parent as ts.Declaration) !== node &&
                    !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
                    !(ts.isQualifiedName(node.parent) && node.parent.right === node)
                ) {
                    const s = checker.getSymbolAtLocation(node);
                    if (
                        s &&
                        s.declarations &&
                        s.declarations.some((d) => ts.isModuleDeclaration(d) && !!(d.flags & ts.NodeFlags.Namespace)) &&
                        s.declarations.some((d) => d.getSourceFile() !== currentSourceFile) && // only namespaces external to the current file
                        !s.declarations.some((d) => d.getSourceFile().fileName.indexOf("lib.") !== -1) && // that are not from the `lib`
                        !s.declarations.some((d) => d.getSourceFile().fileName.indexOf("node_modules") !== -1) && // that are not from `node_modules`
                        !s.declarations.some((d) => d.kind === ts.SyntaxKind.ClassDeclaration) // and nothing that's a class (we can't faithfully repreoduce class/ns merges anyway, so it's easy to toss these)
                    ) {
                        const nsName = checker.symbolToString(s);
                        requiredImports.add(nsName);
                    }
                }
                return ts.visitEachChild(node, visitIdentifiers, context);
            }

            function copyLeadingComments(
                targetNode: Node,
                pos: number,
                sourceFile: ts.SourceFile,
                commentKind?: ts.CommentKind,
                hasTrailingNewLine?: boolean
            ) {
                ts.forEachLeadingCommentRange(
                    sourceFile.text,
                    pos,
                    getAddCommentsFunction(
                        targetNode,
                        sourceFile,
                        commentKind,
                        hasTrailingNewLine,
                        ts.addSyntheticLeadingComment
                    )
                );
                return targetNode;
            }

            function copyTrailingComments(
                targetNode: Node,
                pos: number,
                sourceFile: ts.SourceFile,
                commentKind?: ts.CommentKind,
                hasTrailingNewLine?: boolean
            ) {
                ts.forEachTrailingCommentRange(
                    sourceFile.text,
                    pos,
                    getAddCommentsFunction(
                        targetNode,
                        sourceFile,
                        commentKind,
                        hasTrailingNewLine,
                        ts.addSyntheticTrailingComment
                    )
                );
                return targetNode;
            }

            function getAddCommentsFunction(
                targetNode: Node,
                sourceFile: ts.SourceFile,
                commentKind: ts.CommentKind | undefined,
                hasTrailingNewLine: boolean | undefined,
                cb: (node: Node, kind: ts.CommentKind, text: string, hasTrailingNewLine?: boolean) => void
            ) {
                return (pos: number, end: number, kind: ts.CommentKind, htnl: boolean) => {
                    if (kind === ts.SyntaxKind.MultiLineCommentTrivia) {
                        // Remove leading /*
                        pos += 2;
                        // Remove trailing */
                        end -= 2;
                    } else {
                        // Remove leading //
                        pos += 2;
                    }
                    cb(
                        targetNode,
                        commentKind || kind,
                        sourceFile.text.slice(pos, end),
                        hasTrailingNewLine !== undefined ? hasTrailingNewLine : htnl
                    );
                };
            }

            function visitStatements(statement: Node): ts.VisitResult<Node> {
                if (ts.isModuleDeclaration(statement) && !ts.isStringLiteral(statement.name) && statement.body) {
                    const originalStatement = statement;
                    let body = statement.body;
                    const nsPath = [statement.name];
                    while (ts.isModuleDeclaration(body) && body.body) {
                        nsPath.push(body.name);
                        body = body.body;
                    }
                    if (!ts.isModuleBlock(body)) {
                        return statement;
                    }
                    requiredImports.add(ts.idText(nsPath[0]));
                    const nsFilePath = `${projRootDir}/${nsPath.map(ts.idText).join(".")}.ts`;
                    getOrCreateNamespaceSet({ namespaceFilePath: nsFilePath, configFilePath: configPath }).add(
                        currentSourceFile.fileName
                    );
                    for (let i = 1; i < nsPath.length; i++) {
                        const parentNsFile = `${projRootDir}/${nsPath.map(ts.idText).slice(0, i).join(".")}.ts`;
                        getOrCreateNamespaceSet({ namespaceFilePath: parentNsFile, configFilePath: configPath });
                    }

                    const isInternal =
                        !!ts.isInternalDeclaration(statement, currentSourceFile) &&
                        ts.hasSyntacticModifier(statement, ts.ModifierFlags.Export);
                    const replacement = body.statements.map((s, i) => visitStatement(s, isInternal));

                    // TODO: something here causes comments to be duplicated.
                    if (replacement.length) {
                        return [
                            copyLeadingComments(
                                ts.createNotEmittedStatement(originalStatement),
                                originalStatement.pos,
                                currentSourceFile
                            ),
                            ...replacement,
                            copyTrailingComments(
                                ts.createNotEmittedStatement(originalStatement),
                                originalStatement.end,
                                currentSourceFile
                            ),
                        ];
                    }
                    const placeholder = ts.createNotEmittedStatement(originalStatement);
                    copyLeadingComments(placeholder, originalStatement.pos, currentSourceFile);
                    copyTrailingComments(placeholder, originalStatement.end, currentSourceFile);
                    return placeholder;
                }

                return visitGlobalishStatement(statement);
            }

            function visitStatement(statement: Node, isInternal: boolean) {
                statement = visitIdentifiers(statement);
                // If the statement is an interface and that interface is an augmentation of an interface in another file
                // rewrite it into a module augmentation so that augmentation actually takes place
                if (ts.isInterfaceDeclaration(statement)) {
                    const sym = checker.getSymbolAtLocation(ts.getNameOfDeclaration(statement) || statement)!;
                    if (
                        sym.declarations &&
                        sym.declarations.length > 1 &&
                        !sym.declarations.every((d) => d.getSourceFile() === sym.declarations?.[0].getSourceFile()) &&
                        statement !== sym.declarations[0]
                    ) {
                        const sourceMappedOriginalLocation = getSourceMapper().tryGetSourcePosition({
                            fileName: sym.declarations[0].getSourceFile().fileName,
                            pos: sym.declarations[0].pos,
                        });
                        const targetFilename = sourceMappedOriginalLocation
                            ? sourceMappedOriginalLocation.fileName
                            : sym.declarations[0].getSourceFile().fileName;
                        statement = ts.createModuleDeclaration(
                            /*decorators*/ undefined,
                            [ts.createToken(ts.SyntaxKind.DeclareKeyword)],
                            ts.createLiteral(
                                getTSStyleRelativePath(
                                    currentSourceFile.fileName,
                                    targetFilename.replace(/(\.d)?\.ts$/, "")
                                )
                            ),
                            ts.createModuleBlock([statement])
                        );
                    }
                }
                if (isInternal) {
                    ts.setSyntheticLeadingComments(statement, [
                        {
                            kind: ts.SyntaxKind.MultiLineCommentTrivia,
                            pos: -1,
                            end: -1,
                            text: " @internal ",
                            hasTrailingNewLine: true,
                        },
                    ]);
                }
                return statement;
            }

            function visitGlobalishStatement(statement: Node): ts.VisitResult<Node> {
                statement = visitIdentifiers(statement);
                if (ts.isInterfaceDeclaration(statement) || ts.isVariableStatement(statement)) {
                    const sym = checker.getSymbolAtLocation(
                        ts.getNameOfDeclaration(
                            ts.isVariableStatement(statement) ? statement.declarationList.declarations[0] : statement
                        ) || statement
                    )!;
                    const isMerged =
                        sym.declarations &&
                        sym.declarations.length > 1 &&
                        !sym.declarations.every((d) => d.getSourceFile() === sym.declarations?.[0].getSourceFile());
                    const isAmbient =
                        statement.modifiers && statement.modifiers.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
                    if (isMerged || isAmbient) {
                        // Global interface/declaration - preserve globality
                        // TODO: Check if declaration is non-ambient, if so, use global augmentation to produce global value
                        // and rewrite implementation to rely on `globalThis` (if needed)
                        const isInternal =
                            ts.isInternalDeclaration(statement, currentSourceFile) &&
                            ts.hasSyntacticModifier(statement, ts.ModifierFlags.Export);
                        statement = ts.createModuleDeclaration(
                            /*decorators*/ undefined,
                            [ts.createToken(ts.SyntaxKind.DeclareKeyword)],
                            ts.createIdentifier("global"),
                            ts.createModuleBlock([stripDeclare(statement)]),
                            ts.NodeFlags.GlobalAugmentation
                        );
                        if (isInternal) {
                            ts.setSyntheticLeadingComments(statement, [
                                {
                                    kind: ts.SyntaxKind.MultiLineCommentTrivia,
                                    pos: -1,
                                    end: -1,
                                    text: " @internal ",
                                    hasTrailingNewLine: true,
                                },
                            ]);
                        }
                    }
                }
                return statement;
            }

            function stripDeclare<T extends Node>(statement: T): T {
                if (statement.modifiers && statement.modifiers.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
                    const clone = (ts.factory as any).cloneNode(statement);
                    clone.modifiers = clone.modifiers.filter((m: Node) => m.kind !== ts.SyntaxKind.DeclareKeyword);
                    return ts.setTextRange(clone, statement);
                }
                // TODO: why can't I write this?
                // if (ts.canHaveModifiers(statement) && statement.modifiers && statement.modifiers.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)) {
                //     const clone = ts.factory.cloneNode(statement);
                //     ts.factory.updateModifiers(clone, clone.modifiers!.filter((m: Node) => m.kind !== ts.SyntaxKind.DeclareKeyword));
                //     return ts.setTextRange(clone, statement);
                // }
                return statement;
            }
        }
    }

    function getOrCreateNamespaceSet({
        namespaceFilePath,
        configFilePath,
    }: {
        namespaceFilePath: string;
        configFilePath: string;
    }) {
        const res = newNamespaceFiles.get(namespaceFilePath);
        if (res) {
            return res;
        }
        const s = new NormalizedPathSet();
        newNamespaceFiles.set(namespaceFilePath, s);
        let configRes = extraFilesFieldMembers.get(configFilePath);
        if (!configRes) {
            configRes = new NormalizedPathSet();
            extraFilesFieldMembers.set(configFilePath, configRes);
        }
        configRes.add(namespaceFilePath);
        return s;
    }
}
