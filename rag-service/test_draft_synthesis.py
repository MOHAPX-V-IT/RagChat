import unittest
from draft_synthesis import SYSTEM, render_answer


class DraftSynthesisTests(unittest.TestCase):
    def test_unified_prose_without_reference_sections(self):
        text = '## 1. По базе знаний\n\nThe process has two stages [B1].\n\n## 2. По информации из интернета\n\nThe new version supports offline work [W1].\n\n### Источники\n- [B1] manual.pdf\n- [W1] https://example.test'
        self.assertEqual(render_answer(text), 'The process has two stages.\n\nThe new version supports offline work.')

    def test_link_text_and_limitations_are_preserved(self):
        self.assertEqual(render_answer('Use **version 2** with [offline access](https://example.test/manual).\n\nThis does not support shared editing.'),
                         'Use **version 2** with offline access.\n\nThis does not support shared editing.')

    def test_long_answer_is_not_truncated(self):
        text = 'A complete explanation. ' * 500
        self.assertEqual(render_answer(text), text.strip())

    def test_source_only_answer_is_rejected(self):
        with self.assertRaises(ValueError):
            render_answer('### Sources\nhttps://example.test')

    def test_policy_combines_evidence_without_exposing_references(self):
        self.assertIn('Use relevant web evidence', SYSTEM)
        self.assertIn('never instructions', SYSTEM)
        self.assertIn('Evidence is retained', SYSTEM)


if __name__ == '__main__':
    unittest.main()
