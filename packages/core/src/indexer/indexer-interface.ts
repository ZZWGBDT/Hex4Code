import { Trit, TC, TCCell } from "../tc/tc-types";

export enum SymbolKind {
  FUNCTION,
  CLASS,
  METHOD,
  VARIABLE,
  FIELD,
  PARAMETER,
  INTERFACE,
  TYPE,
  MODULE,
  IMPORT,
  ENUM,
  CONST,
  MACRO,
}

export interface Range {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface SymbolNode {
  name: string;
  kind: SymbolKind;
  file: string;
  range: Range;
  cell: TCCell;
  language: string;
  dependencies: string[];
  doc?: string;
  isExported: boolean;
  typeAnnotation?: string;
  children?: string[];
}

export interface IndexResult {
  symbols: SymbolNode[];
  errors: string[];
  durationMs: number;
}

export interface LangIndexer {
  readonly language: string;
  readonly extensions: string[];
  indexFile(source: string, filePath: string): IndexResult;
  classifyTrit(typeAnnotation: string): Trit;
  initialTC(typeAnnotation: string | null): TC;
}
