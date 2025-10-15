import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
const fs = require("fs");
const path = require("path");
import { PDFParse } from 'pdf-parse';

interface PluginSettings {
	llmModel: string;
	basePrompt: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	llmModel: 'llama3.1',
	basePrompt: "You are an AI tutor. Based on the following material, generate a bunch of concise learning questions formatted in Markdown. Add the right solutions to an extra chapter at the bottom. All Questions should be answered only with the given material, don't ask, what may be in mentioned sources.",
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

					const files = vault.getFiles().filter(
						(f) =>
							f.parent?.path === folderPath &&
							(f.extension === "md" || f.extension === "pdf")
					);

					let allText = "";
					new Notice(`Reading ${files.length} files in ${folderPath}...`);

					for (const file of files) {
						try {
							if (file.extension === "md") {
								const content = await vault.read(file);
								allText += `\n\n# ${file.name}\n${content}`;
							} else if (file.extension === "pdf") {
								const absPath = path.join((vault.adapter as any).basePath, file.path);
								const buffer = fs.readFileSync(absPath);
								const parser = new PDFParse({ data: buffer });
								const textResult = await parser.getText();
								await parser.destroy();
								allText += `\n\n# ${file.name}\n${textResult}`;
							}
						} catch (err) {
							console.error(`Error reading ${file.path}:`, err);
						}
					}

					const now = new Date();
					const date = now.toISOString().split("T")[0]; // yyyy-mm-dd
					const time = now
						.toTimeString()
						.split(" ")[0]
						.replace(/:/g, "_"); // hh_mm_ss → we'll keep hh_mm

					const filename = `${folderPath}/ExampleQuestions_${date}_${time.slice(0, 5)}.md`;
					const fileContent = `
---

**Prompt:** ${this.settings.basePrompt}

**User Details:** ${userPrompt}

---

`
					const newFile = await vault.create(filename, fileContent);
					new Notice("Created Example Exam");
					await this.app.workspace.openLinkText(newFile.path, "", true);

					const ragPrompt = `
${this.settings.basePrompt}

The user may have provided extra information:
${userPrompt}

Use the following directory context (from Markdown and PDF files) to generate your questions:
---
${allText}
`;
					const response = await fetch("http://localhost:11434/api/generate", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							model: this.settings.llmModel,
							prompt: ragPrompt,
							stream: true,
						}),
					});

					const reader = response.body?.getReader();
					const decoder = new TextDecoder("utf-8");

					let partial = "";
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						partial += decoder.decode(value, { stream: true });
						const lines = partial.split("\n");
						partial = lines.pop()!;
						for (const line of lines) {
							if (!line.trim()) continue;
							try {
								const data = JSON.parse(line);
								if (data.response) {
									await this.app.vault.adapter.append(newFile.path, data.response);
								}
							} catch (err) {
								console.warn("Stream parse error:", err);
							}
						}
					}
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

		const titleEl = containerEl.createEl('h1', { text: "RAG LLM Bot Settings"})
		titleEl.style.marginBottom = '0.5em';

		const descEl = containerEl.createEl('div', { text: "Configure RAG and LLM Settings. You can adjust prompts, enable features, etc."})
		descEl.style.marginBottom = '1em';
		descEl.style.fontSize = '0.9em';
		descEl.style.color = 'var(--text-muted)';

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
		new Setting(containerEl)
			.setName('Prompt')
			.setDesc('Set Prompt used by Ollama in the Background, can later be enriched by Modal')
			.addTextArea((text) => {
				text.setPlaceholder(
					'You are an AI Tutor, create 20 Questions with the given context. The Questions should be in following formats: Multiple Choice, Explaining, Calculating'
				);
				text.setValue(this.plugin.settings.basePrompt);

				// Style the textarea
				text.inputEl.style.width = '100%';
				text.inputEl.style.boxSizing = 'border-box';
				text.inputEl.style.minHeight = '120px';

				text.onChange(async (value) => {
					this.plugin.settings.basePrompt = value;
					await this.plugin.saveSettings();
				});
			});
		const lastSetting = containerEl.querySelector('.setting-item:last-child') as HTMLElement;
		if (lastSetting) {
			lastSetting.style.flexDirection = 'column';
			lastSetting.style.alignItems = 'stretch';
		}

	}
}
