/**
 * Canonical JSON for hashing and signing. Core has one RFC 8785 implementation, in
 * changelog/jcs.ts; this module re-exports it so crypto code and the changelog can never
 * disagree about the bytes they hash.
 */
export { canonicalize, CanonicalJsonError } from "@/changelog/jcs";
