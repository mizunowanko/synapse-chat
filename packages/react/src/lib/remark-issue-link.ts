import type { Root, PhrasingContent } from "mdast";
import type {
  FindAndReplaceTuple,
  ReplaceFunction,
} from "mdast-util-find-and-replace";
import { findAndReplace } from "mdast-util-find-and-replace";

const CROSS_REPO_RE = /([\w][\w.-]*)\/([\w][\w.-]*)#(\d+)/g;
// Plain `#N` — guard against matching `#N` that follows a word char (e.g. the
// `#99` inside `owner/repo#99` after the cross-repo pattern has wrapped it in
// a link whose text content still contains the sequence).
const ISSUE_REF_RE = /(?<!\w)#(\d+)/g;

/**
 * remark plugin that converts `#123` and `owner/repo#123` patterns into
 * GitHub issue/PR links.
 *
 * - `owner/repo#N` always links to `https://github.com/owner/repo/issues/N`.
 * - `#N` links to `https://github.com/{ownerRepo}/issues/N` only when
 *   `ownerRepo` is provided; otherwise it is left as plain text to avoid
 *   mis-linking in multi-repo contexts where the target repo is ambiguous.
 *
 * Code spans and code blocks are skipped.
 */
export function remarkIssueLink(options: { ownerRepo?: string } = {}) {
  const { ownerRepo } = options;

  return (tree: Root) => {
    const crossRepoReplace: ReplaceFunction = (
      match: string,
      owner: string,
      repo: string,
      number: string,
    ) =>
      ({
        type: "link",
        url: `https://github.com/${owner}/${repo}/issues/${number}`,
        children: [{ type: "text", value: match }],
      }) satisfies PhrasingContent;

    const replacements: FindAndReplaceTuple[] = [
      [CROSS_REPO_RE, crossRepoReplace],
    ];

    if (ownerRepo) {
      const plainReplace: ReplaceFunction = (
        _match: string,
        number: string,
      ) =>
        ({
          type: "link",
          url: `https://github.com/${ownerRepo}/issues/${number}`,
          children: [{ type: "text", value: `#${number}` }],
        }) satisfies PhrasingContent;
      replacements.push([ISSUE_REF_RE, plainReplace]);
    }

    findAndReplace(tree, replacements, {
      ignore: ["code", "inlineCode"],
    });
  };
}
