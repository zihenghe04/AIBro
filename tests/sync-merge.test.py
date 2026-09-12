"""The Python and JavaScript merge engines must pass identical JSON cases."""
import copy
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str((Path(__file__).resolve().parents[1] / 'app')))
from sync_merge import MergeConflict, merge_local_snapshot

FIXTURES = json.loads((Path(__file__).parent / 'fixtures' / 'sync-merge.json').read_text())

class MergeTests(unittest.TestCase):
    pass

def fixture_test(case):
    def run(self):
        originals = copy.deepcopy([case['base'], case['proposed'], case['current']])
        if 'conflict' in case:
            with self.assertRaises(MergeConflict) as error: merge_local_snapshot(case['base'], case['proposed'], case['current'])
            self.assertEqual(error.exception.path, case['conflict'])
        else:
            result = merge_local_snapshot(case['base'], case['proposed'], case['current'])
            self.assertEqual(result, case['expected'])
            self.assertIsNot(result, case['proposed'])
        self.assertEqual([case['base'], case['proposed'], case['current']], originals)
    return run

for index, case in enumerate(FIXTURES): setattr(MergeTests, 'test_%02d_%s' % (index, case['name'].replace(' ', '_')), fixture_test(case))

if __name__ == '__main__': unittest.main()
