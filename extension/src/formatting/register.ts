import * as vscode from 'vscode';
import { AngelscriptClangDocumentFormattingEditProvider } from './formatter';
import { generateConfigFile } from './generate-config';
import { Logger } from './logger';

export function registerFormatting(context: vscode.ExtensionContext): void {
    const formatter = new AngelscriptClangDocumentFormattingEditProvider(context);
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider('angelscript', formatter),
        vscode.languages.registerDocumentRangeFormattingEditProvider('angelscript', formatter),
        vscode.languages.registerOnTypeFormattingEditProvider('angelscript', formatter, '\n', '('),
        vscode.commands.registerCommand('unreal-angelscript-clang-format.generate-config-file', () =>
            generateConfigFile(context.extensionUri)),
        { dispose: () => Logger.dispose() },
    );
}
