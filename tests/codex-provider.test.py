import json, sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from codex_bridge import provider_choice, error_info


class ProviderChoice(unittest.TestCase):
    def test_private_pins_openai_shared_keeps_user_provider(self):
        self.assertEqual(provider_choice('private'), {'modelProvider': 'openai'})
        self.assertEqual(provider_choice('shared'), {})

    def test_unknown_model_is_categorised_without_text(self):
        message = json.dumps({'type': 'error', 'status': 400, 'error': {'code': 'model_not_found', 'message': 'x'}})
        self.assertEqual(error_info({'message': message, 'codexErrorInfo': 'other'}), {'kind': 'modelNotSupported'})
        self.assertEqual(error_info({'message': 'boom', 'codexErrorInfo': 'other'}), {'kind': 'other'})


if __name__ == '__main__': unittest.main()
