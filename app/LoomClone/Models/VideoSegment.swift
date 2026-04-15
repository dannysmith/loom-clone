import Foundation

/// A segment ready for upload. References a file on the local recordings
/// directory rather than carrying bytes in memory — the upload path re-reads
/// from disk on each attempt, so a segment can sit in the queue during a long
/// outage without holding its payload in RAM.
struct VideoSegment: Sendable {
    let index: Int
    let filename: String
    let localURL: URL
    let duration: Double
    let type: SegmentType

    enum SegmentType: Sendable {
        case initialization
        case media
    }
}
