import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
const path = require("path");

interface PluginSettings {
	llmModel: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	llmModel: 'llama3'
}

export default class RagLLmBotPlugin extends Plugin {
	settings: PluginSettings;

	async onload() {
		console.log('RagLLmBotPlugin.onload');
		await this.loadSettings();

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'create-learning-questions',
			name: 'Create an Example Exam',
			callback: async () => {
				new PromptEngineeringModal(this.app, async (userPrompt) => {
					const activeFile = this.app.workspace.getActiveFile();
					if (!activeFile) {
						new Notice("No active file selected. Please select one");
						return;
					}
					const folderPath = path.dirname(activeFile.path);
					const vault = this.app.vault;

					const now = new Date();
					const date = now.toISOString().split("T")[0]; // yyyy-mm-dd
					const time = now
						.toTimeString()
						.split(" ")[0]
						.replace(/:/g, "_"); // hh_mm_ss → we'll keep hh_mm

					const filename = `${folderPath}/Testexam_${date}_${time.slice(0, 5)}.md`;
					const fileContent = `# Testing your knowledge with a few Questions...`
					const newFile = await vault.create(filename, fileContent);
					new Notice("Created Example Exam");
					await this.app.workspace.openLinkText(newFile.path, "", true);
				}).open();
			}
		})

		// This adds a settings tab so the user can configure some aspects of the plugin
		this.addSettingTab(new RagLlmBotSettingTab(this.app, this));
	}

	onunload() {
		console.log('RagLLmBotPlugin.onunload');
	}

	async loadSettings() {
		console.log('RagLLmBotPlugin.loadSettings');
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		console.log('RagLLmBotPlugin.saveSettings');
		await this.saveData(this.settings);
	}
}

class PromptEngineeringModal extends Modal {
	constructor(app: App, onSubmit: (result: string) => void) {
		super(app);
		this.setTitle("Additional Details");
		this.setContent("You can add additional details, that will be added to the prompt for the llm! The currently selected file and its directory will be automatically be added as context.");
		let userPrompt = '';
		new Setting(this.contentEl)
			.addTextArea((text) => {
				text.inputEl.style.width = '100%';
				text.inputEl.style.boxSizing = 'border-box';
				text.inputEl.style.minHeight = '120px';
				text.setPlaceholder("Your extra details...")
				text.onChange((value) => {
					userPrompt = value;
				});
			});
		const lastSetting = this.contentEl.querySelector(".setting-item:last-child") as HTMLElement;
		if (lastSetting) {
			lastSetting.style.flexDirection = "column";
			lastSetting.style.alignItems = "stretch";
		}
		new Setting(this.contentEl)
			.addButton((btn) =>
			btn.setButtonText('Submit')
				.setCta()
				.onClick(() => {
					console.log('PromptEngineeringModal.onSubmit');
					this.close();
					onSubmit(userPrompt);
				}));
	}

	onOpen() {
		console.log('PromptEngineeringModal.onOpen');
	}
}

class RagLlmBotSettingTab extends PluginSettingTab {
	plugin: RagLLmBotPlugin;

	constructor(app: App, plugin: RagLLmBotPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('LLM Model')
			.setDesc('Set LLM Model used by Ollama in the Background')
			.addText(text => text
				.setPlaceholder('Enter a Model')
				.setValue(this.plugin.settings.llmModel)
				.onChange(async (value) => {
					this.plugin.settings.llmModel = value;
					await this.plugin.saveSettings();
				}));
	}
}
