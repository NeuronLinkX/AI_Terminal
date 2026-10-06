// Reads the text of images with Apple's Vision framework and reports which of the given strings occur in them.
//   swiftc -O scripts/ocr-check.swift -o /tmp/ocr-check
//   OCR_PATTERNS="name1,name2,10.0.0.5" /tmp/ocr-check frame1.png frame2.jpg ...
// Prints one line per image: the number of recognised characters and the patterns found (by position in OCR_PATTERNS, never the text),
// so the result can be shared without exposing the strings that were searched for. Exit status 1 when any pattern is found.
import Foundation
import Vision
import AppKit

let patterns = (ProcessInfo.processInfo.environment["OCR_PATTERNS"] ?? "").split(separator: ",").map { String($0).lowercased() }.filter { !$0.isEmpty }
var found = false
for path in CommandLine.arguments.dropFirst() {
  guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("ERR \(path)"); continue }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.recognitionLanguages = ["ko-KR", "en-US"]
  try? VNImageRequestHandler(cgImage: cg).perform([req])
  let text = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n").lowercased()
  let hits = patterns.enumerated().filter { text.contains($0.element) }.map { "#\($0.offset)" }
  if !hits.isEmpty { found = true }
  print("\((path as NSString).lastPathComponent): \(text.count) chars, hits=\(hits)")
}
exit(found ? 1 : 0)
