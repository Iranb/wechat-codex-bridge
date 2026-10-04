import Foundation
import CoreImage
import CoreImage.CIFilterBuiltins
import ImageIO
import UniformTypeIdentifiers

let input = FileHandle.standardInput.readDataToEndOfFile()
let filter = CIFilter.qrCodeGenerator()
filter.message = input
filter.correctionLevel = "M"
guard let image = filter.outputImage else { exit(1) }
let bounds = image.extent.integral
let width = Int(bounds.width)
let height = Int(bounds.height)
let context = CIContext()
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--png" {
    let paddedBounds = image.extent.insetBy(dx: -4, dy: -4)
    let white = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: paddedBounds)
    let padded = image.composited(over: white).transformed(by: CGAffineTransform(scaleX: 12, y: 12))
    guard let bitmap = context.createCGImage(padded, from: padded.extent),
          let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
    CGImageDestinationAddImage(destination, bitmap, nil)
    guard CGImageDestinationFinalize(destination) else { exit(1) }
    exit(0)
}
let pixels = UnsafeMutablePointer<UInt8>.allocate(capacity: width * height)
defer { pixels.deallocate() }
context.render(image, toBitmap: pixels, rowBytes: width, bounds: bounds, format: .L8, colorSpace: CGColorSpaceCreateDeviceGray())
for y in -4..<(height + 4) {
    var row = ""
    for x in -4..<(width + 4) {
        let dark = x >= 0 && x < width && y >= 0 && y < height && pixels[y * width + x] < 128
        row += dark ? "\u{001B}[40m  " : "\u{001B}[47m  "
    }
    print(row + "\u{001B}[0m")
}
