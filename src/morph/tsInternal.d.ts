import { ts } from "ts-morph";

declare module "ts-morph" {
    namespace ts {
        function isInternalDeclaration(node: Node, currentSourceFile: SourceFile): boolean | 0 | undefined;

        function hasSyntacticModifier(node: Node, flags: ModifierFlags): boolean;

        interface DocumentPositionMapper {
            getSourcePosition(input: DocumentPosition): DocumentPosition;
            getGeneratedPosition(input: DocumentPosition): DocumentPosition;
        }
        interface DocumentPosition {
            fileName: string;
            pos: number;
        }

        interface SourceMapper {
            toLineColumnOffset(fileName: string, position: number): ts.LineAndCharacter;
            tryGetSourcePosition(info: DocumentPosition): DocumentPosition | undefined;
            tryGetGeneratedPosition(info: DocumentPosition): DocumentPosition | undefined;
            clearCache(): void;
        }

        interface SourceMapperHost {
            useCaseSensitiveFileNames(): boolean;
            getCurrentDirectory(): string;
            getProgram(): Program | undefined;
            fileExists?(path: string): boolean;
            readFile?(path: string, encoding?: string): string | undefined;
            getSourceFileLike?(fileName: string): ts.SourceFileLike | undefined;
            getDocumentPositionMapper?(
                generatedFileName: string,
                sourceFileName?: string
            ): DocumentPositionMapper | undefined;
            log(s: string): void;
        }

        function getSourceMapper(host: SourceMapperHost): SourceMapper;

        interface TypeChecker {
            symbolToString(
                checker: TypeChecker,
                symbol: Symbol,
                enclosingDeclaration?: Node,
                meaning?: SymbolFlags,
                flags?: SymbolFormatFlags
            ): string;
        }
    }

    interface Node {
        // Until https://github.com/dsherret/ts-morph/issues/1256 is fixed and released.
        _getNodeFromCompilerNode<LocalCompilerNodeType extends ts.Node = ts.Node>(compilerNode: LocalCompilerNodeType);
        _getNodeFromCompilerNodeIfExists<LocalCompilerNodeType extends ts.Node = ts.Node>(
            compilerNode: LocalCompilerNodeType | undefined
        ): CompilerNodeToWrappedType<LocalCompilerNodeType> | undefined;
    }
}
