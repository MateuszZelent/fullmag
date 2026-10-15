using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Avalonia;
using Fullmag.Setup.UI.Broker;

namespace Fullmag.Setup.UI;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        App.Configure(UiOptions.Parse(args));
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .LogToTrace();
}

internal sealed record UiOptions(
    string? LicenseFile,
    string? InitialCheckoutPath,
    string? InitialStorageRoot,
    string? InitialLane,
    string? SetupScript,
    string? RequirementsManifest,
    string? SetupHash,
    string? ManifestHash)
{
    public static UiOptions Parse(string[] args)
    {
        var values = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length; index++)
        {
            var argument = args[index];
            if (!argument.StartsWith("--", StringComparison.Ordinal))
            {
                continue;
            }

            var nameAndValue = argument[2..].Split('=', 2);
            var name = nameAndValue[0];
            var value = nameAndValue.Length == 2
                ? nameAndValue[1]
                : index + 1 < args.Length && !args[index + 1].StartsWith("--", StringComparison.Ordinal)
                    ? args[++index]
                    : string.Empty;
            if (!values.TryGetValue(name, out var entries))
            {
                entries = new List<string>();
                values.Add(name, entries);
            }
            entries.Add(value);
        }

        return new UiOptions(
            First(values, "license-file"),
            First(values, "checkout"),
            First(values, "storage-root"),
            First(values, "lane"),
            First(values, "setup-script"),
            First(values, "requirements-manifest"),
            First(values, "setup-hash"),
            First(values, "manifest-hash"));
    }

    public IBrokerClient CreateBroker()
    {
        // The native BA owns the verified GUI process and passes the private
        // JSON-lines connection through inherited standard handles.  A GUI
        // started directly by an operator is visibly blocked; it never starts
        // a helper, PowerShell, or another broker process on its own.
        if (!Console.IsInputRedirected || !Console.IsOutputRedirected)
        {
            return new MissingBrokerClient();
        }

        return new JsonLinesBrokerClient(
            Console.OpenStandardInput(),
            Console.OpenStandardOutput());
    }

    public string LoadLicenseText()
    {
        if (string.IsNullOrWhiteSpace(LicenseFile))
        {
            return string.Empty;
        }

        try
        {
            var info = new FileInfo(LicenseFile);
            if (!info.Exists || info.Length == 0 || info.Length > 1_048_576)
            {
                return string.Empty;
            }

            using var stream = new FileStream(
                LicenseFile,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                64 * 1024,
                FileOptions.SequentialScan);
            using var reader = new StreamReader(stream, new UTF8Encoding(false, true));
            return reader.ReadToEnd();
        }
        catch (IOException)
        {
            return string.Empty;
        }
        catch (UnauthorizedAccessException)
        {
            return string.Empty;
        }
        catch (DecoderFallbackException)
        {
            return string.Empty;
        }
    }

    private static string? First(
        IReadOnlyDictionary<string, List<string>> values,
        string name) => values.TryGetValue(name, out var entries) ? entries.LastOrDefault() : null;
}
