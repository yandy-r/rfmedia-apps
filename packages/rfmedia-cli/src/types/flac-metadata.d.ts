/**
 * Type declarations for the flac-metadata npm package.
 *
 * This package provides stream-based FLAC metadata processing.
 * No DefinitelyTyped package exists, so these declarations are manually created.
 *
 * @see https://github.com/claus/flac-metadata
 * @module types/flac-metadata
 */

declare module "flac-metadata" {
  import { Transform } from "node:stream";

  /**
   * FLAC metadata processor that works as a transform stream.
   * Allows reading and modifying FLAC metadata blocks.
   *
   * Note: This class extends Transform but we use interface merging
   * to add the custom event types without conflicting with base class signatures.
   */
  export class Processor extends Transform {
    /** Metadata block type for Vorbis comments */
    static MDB_TYPE_VORBIS_COMMENT: number;

    /** Metadata block type for stream info */
    static MDB_TYPE_STREAMINFO: number;

    /** Metadata block type for padding */
    static MDB_TYPE_PADDING: number;

    /** Metadata block type for application data */
    static MDB_TYPE_APPLICATION: number;

    /** Metadata block type for seek table */
    static MDB_TYPE_SEEKTABLE: number;

    /** Metadata block type for cue sheet */
    static MDB_TYPE_CUESHEET: number;

    /** Metadata block type for picture */
    static MDB_TYPE_PICTURE: number;
  }

  /**
   * Event interface for type-safe event handling.
   * Use with processor.on() for preprocess and postprocess events.
   */
  export interface ProcessorEvents {
    preprocess: (mdb: MetadataBlock) => void;
    postprocess: (mdbList: MetadataBlockList) => void;
  }

  /**
   * Represents a FLAC metadata block.
   */
  export interface MetadataBlock {
    /** The type of metadata block (use Processor.MDB_TYPE_* constants) */
    type: number;

    /** Whether this is the last metadata block */
    isLast: boolean;

    /** Remove this block from the output stream */
    remove(): void;

    /** Raw block data (only for certain block types) */
    data?: VorbisCommentData;
  }

  /**
   * List of metadata blocks for adding new blocks in postprocess.
   */
  export interface MetadataBlockList {
    /** Add a new metadata block to the output */
    push(block: VorbisCommentBlock): void;
  }

  /**
   * Structure for creating a new Vorbis comment block.
   */
  export interface VorbisCommentBlock {
    /** Must be Processor.MDB_TYPE_VORBIS_COMMENT */
    type: number;

    /** Vendor string identifying the encoder */
    vendor: string;

    /** Array of comment strings in "KEY=value" format */
    comments: string[];
  }

  /**
   * Parsed Vorbis comment data from an existing block.
   */
  export interface VorbisCommentData {
    /** Vendor string identifying the encoder */
    vendor: string;

    /** Array of comment strings in "KEY=value" format */
    comments: string[];
  }

  /**
   * Extract Vorbis comment data from a metadata block.
   *
   * @param block - The metadata block to extract data from
   * @returns The parsed Vorbis comment data
   */
  export function data(block: MetadataBlock): VorbisCommentData;
}
