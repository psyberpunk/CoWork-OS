import SwiftUI

@main
struct CoWorkCompanionApp: App {
    @StateObject private var connection = CoWorkConnection()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(connection)
        }
    }
}
