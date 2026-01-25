import { createStore } from "solid-js/store";

interface SelectionRange {
  startLine: number;
  endLine: number;
}

interface EditorState {
  selectedText: string;
  selectedFile: string | null;
  selectedRange: SelectionRange | null;
}

const [state, setState] = createStore<EditorState>({
  selectedText: "",
  selectedFile: null,
  selectedRange: null,
});

export const editorStore = {
  get selectedText() {
    return state.selectedText;
  },
  get selectedFile() {
    return state.selectedFile;
  },
  get selectedRange() {
    return state.selectedRange;
  },
  setSelection(text: string, file: string, range: SelectionRange) {
    setState({ selectedText: text, selectedFile: file, selectedRange: range });
  },
  clearSelection() {
    setState({ selectedText: "", selectedFile: null, selectedRange: null });
  },
};
