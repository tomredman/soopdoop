// ABOUTME: Fits the icon art (icon.py's full-bleed render) to Apple's macOS app icon template, at every size an .icns
// ABOUTME: holds: a continuous-corner square, see-through around it, with a soft shadow. Run: swift template.swift <art.png> <out.iconset>
import CoreGraphics
import Foundation
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

// Apple's template on the 1024 px canvas: the body is 824 px, 100 px in from each edge, with continuous corners of
// radius 185.4 px. macOS 26 shows an icon this shape as it is; anything else goes on a grey plate. macOS 14 and 15 draw
// the icon as it is, so the see-through edge is what makes it the right size next to other apps.
let canvas: CGFloat = 1024
let inset: CGFloat = 100
let radius: CGFloat = 185.4
// The template's shadow falls about 15 px to the sides and 25 px below the body.
let shadowDrop: CGFloat = 10
let shadowBlur: CGFloat = 16
let shadowAlpha: CGFloat = 0.3
// A thin light rim just inside the edge, brighter at the top, so the dark icon still reads on a dark Dock.
let rimWidth: CGFloat = 2.5
let rimTop: CGFloat = 0.18
let rimBottom: CGFloat = 0.03

// Each size the iconset holds, as (file name, pixels).
let sizes: [(String, Int)] = [16, 32, 128, 256, 512].flatMap { points in
    [("icon_\(points)x\(points).png", points), ("icon_\(points)x\(points)@2x.png", points * 2)]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("template: \(message)\n".utf8))
    exit(1)
}

func load(_ path: String) -> CGImage {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("cannot read \(path)") }
    return image
}

// The icon at one size, drawn straight from the full-size art so small sizes stay sharp.
func icon(from art: CGImage, pixels: Int) -> CGImage {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("cannot draw \(pixels) px") }
    let scale = CGFloat(pixels) / canvas
    context.interpolationQuality = .high
    context.scaleBy(x: scale, y: scale)
    let body = CGRect(x: inset, y: inset, width: canvas - 2 * inset, height: canvas - 2 * inset)
    let shape = RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: body).cgPath
    // The shadow, cast by the body's shape (a shadow's offset and blur are in pixels, so they are scaled by hand).
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -shadowDrop * scale), blur: shadowBlur * scale,
                      color: CGColor(gray: 0, alpha: shadowAlpha))
    context.addPath(shape)
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    context.fillPath()
    context.restoreGState()
    // The art, inside the body.
    context.saveGState()
    context.addPath(shape)
    context.clip()
    context.draw(art, in: body)
    // The rim: a stroke along the edge, clipped to its inside half, shaded from the top down.
    context.addPath(shape)
    context.setLineWidth(rimWidth * 2)
    context.replacePathWithStrokedPath()
    context.clip()
    let rim = [CGColor(gray: 1, alpha: rimTop), CGColor(gray: 1, alpha: rimBottom)]
    if let gradient = CGGradient(colorsSpace: space, colors: rim as CFArray, locations: [0, 1]) {
        context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: body.maxY), end: CGPoint(x: 0, y: body.minY), options: [])
    }
    context.restoreGState()
    guard let image = context.makeImage() else { fail("cannot finish \(pixels) px") }
    return image
}

func save(_ image: CGImage, to url: URL) {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        fail("cannot write \(url.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    if !CGImageDestinationFinalize(destination) { fail("cannot write \(url.path)") }
}

let args = CommandLine.arguments
if args.count != 3 { fail("usage: swift template.swift <art.png> <out.iconset>") }
let art = load(args[1])
let out = URL(fileURLWithPath: args[2])
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
for (name, pixels) in sizes {
    save(icon(from: art, pixels: pixels), to: out.appendingPathComponent(name))
}
print("wrote \(sizes.count) sizes to \(out.path)")
