using System;
using System.Threading.Tasks;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Platform.Storage;
using Fullmag.Setup.UI.ViewModels;

namespace Fullmag.Setup.UI;

public partial class MainWindow : Window
{
    private bool _closing;

    public MainWindow()
    {
        InitializeComponent();
    }

    private async void OnClosing(object? sender, WindowClosingEventArgs eventArgs)
    {
        if (_closing || DataContext is not MainWindowViewModel viewModel)
        {
            return;
        }

        eventArgs.Cancel = true;
        _closing = true;
        await viewModel.ShutdownAsync().ConfigureAwait(true);
        Close();
    }

    private async void BrowseCheckout(object? sender, RoutedEventArgs eventArgs)
    {
        await BrowseFolderAsync(
            "Choose the Fullmag source folder",
            path =>
            {
                if (DataContext is MainWindowViewModel viewModel)
                {
                    viewModel.CheckoutPath = path;
                }
            }).ConfigureAwait(true);
    }

    private async void BrowseStorage(object? sender, RoutedEventArgs eventArgs)
    {
        await BrowseFolderAsync(
            "Choose the build and results storage folder",
            path =>
            {
                if (DataContext is MainWindowViewModel viewModel)
                {
                    viewModel.StorageRoot = path;
                }
            }).ConfigureAwait(true);
    }

    private async Task BrowseFolderAsync(string title, Action<string> assign)
    {
        var topLevel = TopLevel.GetTopLevel(this);
        if (topLevel?.StorageProvider is not { } storageProvider)
        {
            return;
        }

        var folders = await storageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
        {
            Title = title,
            AllowMultiple = false
        }).ConfigureAwait(true);
        if (folders.Count != 1)
        {
            return;
        }

        var path = folders[0].Path?.LocalPath;
        if (!string.IsNullOrWhiteSpace(path))
        {
            assign(path);
        }
    }
}
