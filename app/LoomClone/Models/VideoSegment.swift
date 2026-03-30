import Foundation

struct VideoSegment: Sendable {
    let index: Int
    let filename: String
    let data: Data
    let duration: Double
    let type: SegmentType

    enum SegmentType: Sendable {
        case initialization
        case media
    }
}
