import AVFoundation
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import Photos
import UniformTypeIdentifiers

struct Failure: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
let args = Array(CommandLine.arguments.dropFirst())
func values(_ key: String) -> [String] {
  args.indices.compactMap { args[$0] == "--" + key && $0 + 1 < args.count ? args[$0 + 1] : nil }
}
func option(_ key: String) throws -> String {
  guard let value = values(key).first else { throw Failure("Missing --" + key) }
  return value
}
func destination() throws -> URL {
  let out = URL(fileURLWithPath: try option("out")).resolvingSymlinksInPath()
  guard
    !out.resolvingSymlinksInPath().pathComponents.contains(where: {
      $0.lowercased().hasSuffix(".photoslibrary")
    })
  else { throw Failure("Choose a destination outside Photos libraries") }
  return out
}
func emit(_ value: [String: Any]) throws {
  print(String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self))
}
func sheet() throws {
  let out = try destination()
  let items = values("item")
  guard let size = Int(try option("size")), (32...1024).contains(size),
    let cols = Int(try option("cols")), (1...12).contains(cols), (1...64).contains(items.count)
  else { throw Failure("Invalid contact sheet dimensions") }
  let w = min(cols, items.count) * size
  let h = ((items.count + cols - 1) / cols) * (size + 32)
  guard
    let ctx = CGContext(
      data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
  else { throw Failure("Canvas allocation failed") }
  ctx.setFillColor(gray: 1, alpha: 1)
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  for (i, item) in items.enumerated() {
    let parts = item.split(separator: "=", maxSplits: 1)
    guard parts.count == 2,
      let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: String(parts[1])) as CFURL, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(
        src, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: size,
        ] as CFDictionary)
    else { throw Failure("Unreadable thumbnail") }
    let x = (i % cols) * size
    let y = h - (i / cols + 1) * (size + 32)
    ctx.draw(
      image,
      in: CGRect(
        x: x + (size - image.width) / 2, y: y + 32 + (size - image.height) / 2, width: image.width,
        height: image.height))
    ctx.textPosition = CGPoint(x: x + 4, y: y + 9)
    let label = NSAttributedString(
      string: String(parts[0]),
      attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName(
          "Helvetica" as CFString, 13, nil)
      ])
    CTLineDraw(CTLineCreateWithAttributedString(label), ctx)
  }
  let data = NSMutableData()
  guard
    let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil),
    let image = ctx.makeImage()
  else { throw Failure("JPEG creation failed") }
  CGImageDestinationAddImage(dest, image, nil)
  guard CGImageDestinationFinalize(dest) else { throw Failure("JPEG encoding failed") }
  try (data as Data).write(to: out, options: .withoutOverwriting)
  try emit(["ok": true, "path": out.path])
}
func editedFallback(_ asset: PHAsset, _ out: URL, _ budget: Int, _ network: Bool) async throws {
  let estimate = args.first == "estimate"
  let directory = (try? out.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
  let parent =
    estimate
    ? FileManager.default.temporaryDirectory : (directory ? out : out.deletingLastPathComponent())
  let temporary = parent.appendingPathComponent(UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: temporary) }
  let uti: String
  let cloud: Bool
  if asset.mediaType == .video {
    guard #available(macOS 15, *) else { throw Failure("Edited video rendering requires macOS 15") }
    let opts = PHVideoRequestOptions()
    opts.version = .current
    opts.isNetworkAccessAllowed = network
    let (session, downloaded): (AVAssetExportSession, Bool) =
      try await withCheckedThrowingContinuation { continuation in
        PHImageManager.default().requestExportSession(
          forVideo: asset, options: opts, exportPreset: AVAssetExportPresetHighestQuality
        ) { session, info in
          if let session {
            continuation.resume(
              returning: (session, info?[PHImageResultIsInCloudKey] as? Bool ?? false))
          } else {
            continuation.resume(throwing: Failure("Edited video unavailable"))
          }
        }
      }
    try await session.export(to: temporary, as: .mov)
    uti = UTType.quickTimeMovie.identifier
    cloud = downloaded
  } else {
    let opts = PHImageRequestOptions()
    opts.version = .current
    opts.deliveryMode = .highQualityFormat
    opts.isNetworkAccessAllowed = network
    let (data, type, downloaded): (Data, String, Bool) = try await withCheckedThrowingContinuation {
      continuation in
      PHImageManager.default().requestImageDataAndOrientation(for: asset, options: opts) {
        data, type, _, info in
        if let data, let type {
          continuation.resume(
            returning: (data, type, info?[PHImageResultIsInCloudKey] as? Bool ?? false))
        } else {
          continuation.resume(throwing: Failure("Edited photo unavailable"))
        }
      }
    }
    uti = type
    cloud = downloaded
    if estimate {
      try emit(["bytes": data.count])
      return
    }
    guard data.count <= budget else { throw Failure("Expected bytes: " + String(data.count)) }
    try data.write(to: temporary, options: .withoutOverwriting)
  }
  let bytes = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
  if estimate {
    try emit(["bytes": bytes])
    return
  }
  guard bytes <= budget else { throw Failure("Expected bytes: " + String(bytes)) }
  let name =
    String(asset.localIdentifier.prefix(8)) + "_edited."
    + (UTType(uti)?.preferredFilenameExtension ?? "bin")
  let target = directory ? out.appendingPathComponent(name) : out
  try FileManager.default.linkItem(at: temporary, to: target)
  try emit([
    "ok": true,
    "files": [
      [
        "path": target.path, "bytes": bytes, "uti": uti,
        "resourceType": asset.mediaType == .video ? 6 : 5, "fromIcloud": cloud,
      ]
    ], "error": NSNull(),
  ])
}
func export() async throws {
  let id = try option("id")
  let variant = try option("variant")
  let out = try destination()
  guard let budget = Int(try option("max-bytes")), budget > 0,
    let network = Bool(try option("allow-network"))
  else { throw Failure("Invalid export options") }
  let opts = PHFetchOptions()
  opts.includeAssetSourceTypes = [.typeUserLibrary]
  guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: opts).firstObject,
    !asset.isHidden
  else { throw Failure("Active asset unavailable") }
  let resources = PHAssetResource.assetResources(for: asset).filter { r in
    switch variant {
    case "original": return r.type == .photo || r.type == .video
    case "edited": return r.type == .fullSizePhoto || r.type == .fullSizeVideo
    case "live_video": return r.type == .pairedVideo
    case "raw": return UTType(r.uniformTypeIdentifier)?.conforms(to: .rawImage) == true
    case "all": return true
    default: return false
    }
  }
  if variant == "edited" && resources.isEmpty {
    guard #available(macOS 12, *), asset.hasAdjustments else {
      throw Failure("Asset has no edited rendition")
    }
    try await editedFallback(asset, out, budget, network)
    return
  }
  if args.first == "estimate" {
    guard #available(macOS 27, *), !resources.isEmpty, resources.allSatisfy({ $0.dataSize != nil })
    else { throw Failure("Exact resource size unavailable") }
    try emit(["bytes": resources.reduce(0) { $0 + ($1.dataSize ?? 0) }])
    return
  }
  var dir: ObjCBool = false
  let directory =
    FileManager.default.fileExists(atPath: out.path, isDirectory: &dir) && dir.boolValue
  guard !resources.isEmpty, directory || resources.count == 1 else {
    throw Failure("Variant unavailable or directory required")
  }
  if #available(macOS 27, *) {
    let expected = resources.reduce(0) { $0 + ($1.dataSize ?? 0) }
    guard expected <= budget else { throw Failure("Expected bytes: " + String(expected)) }
  }
  var files = [[String: Any]]()
  var total = 0
  var installed = [URL]()
  var finished = false
  var names = Set<String>()
  defer { if !finished { for url in installed { try? FileManager.default.removeItem(at: url) } } }
  for (index, r) in resources.enumerated() {
    let name: String
    if #available(macOS 27, *) {
      name = r.filename ?? "resource"
    } else {
      name = r.originalFilename
    }
    let sanitized = (name as NSString).lastPathComponent.replacingOccurrences(of: ":", with: "_")
    let prefix = names.insert(sanitized.lowercased()).inserted ? "" : String(index) + "_"
    let target =
      directory ? out.appendingPathComponent(String(id.prefix(8)) + "_" + prefix + sanitized) : out
    let tmp = target.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: tmp) }
    let options = PHAssetResourceRequestOptions()
    options.isNetworkAccessAllowed = false
    var downloaded = false
    do {
      try await PHAssetResourceManager.default().writeData(for: r, toFile: tmp, options: options)
    } catch
      where network && (error as NSError).domain == PHPhotosErrorDomain
      && (error as NSError).code == PHPhotosError.Code.networkAccessRequired.rawValue
    {
      if FileManager.default.fileExists(atPath: tmp.path) {
        try FileManager.default.removeItem(at: tmp)
      }
      options.isNetworkAccessAllowed = true
      try await PHAssetResourceManager.default().writeData(for: r, toFile: tmp, options: options)
      downloaded = true
    }
    let bytes = try tmp.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    total += bytes
    guard total <= budget else { throw Failure("Export exceeds byte budget") }
    try FileManager.default.linkItem(at: tmp, to: target)
    installed.append(target)
    files.append([
      "path": target.path, "bytes": bytes, "uti": r.uniformTypeIdentifier,
      "resourceType": r.type.rawValue, "fromIcloud": downloaded,
    ])
  }
  finished = true
  try emit(["ok": true, "files": files, "error": NSNull()])
}
do {
  switch args.first {
  case "status":
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    let opts = PHFetchOptions()
    opts.includeAllBurstAssets = true
    try emit([
      "authorized": status == .authorized || status == .limited, "status": status.rawValue,
      "activeCount": PHAsset.fetchAssets(with: nil).count,
      "allBurstCount": PHAsset.fetchAssets(with: opts).count,
    ])
  case "estimate", "export": try await export()
  case "contact-sheet": try sheet()
  default: throw Failure("Unknown command")
  }
} catch {
  try emit(["ok": false, "files": [], "error": error.localizedDescription])
  exit(1)
}
