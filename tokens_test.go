package drawdown_test

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/heedle-ai/draft/sexpr"
)

// tokenCase is one program in testdata/tokens.json: whether draft reads
// it, and the tokens the page (static/lib.js DD.tokens) splits it into.
type tokenCase struct {
	Name   string      `json:"name"`
	Src    string      `json:"src"`
	OK     bool        `json:"ok"`
	Tokens [][2]string `json:"tokens"`
}

// TestInv_TokensAgreeWithDraft checks the page's tokens against draft's
// reader: they spell the program; draft reads exactly the programs the
// corpus says it does; and for those, the tokens left once spaces and
// comments are dropped build the forms draft reads, list by list,
// string by string (unescaped) and atom by atom. ui/lib.test.js checks
// the page still splits the corpus this way.
func TestInv_TokensAgreeWithDraft(t *testing.T) {
	b, err := os.ReadFile("testdata/tokens.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []tokenCase
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 20 {
		t.Fatalf("only %d cases", len(cases))
	}
	for _, c := range cases {
		var spelled strings.Builder
		bad := false
		for _, tk := range c.Tokens {
			spelled.WriteString(tk[1])
			bad = bad || tk[0] == "bad"
		}
		if spelled.String() != c.Src {
			t.Errorf("%s: tokens spell %q", c.Name, spelled.String())
			continue
		}
		forms, err := sexpr.Read(c.Src)
		if (err == nil) != c.OK {
			t.Errorf("%s: draft reads it: %v, corpus says %v (%v)", c.Name, err == nil, c.OK, err)
			continue
		}
		if bad && c.OK {
			t.Errorf("%s: a bad token in a program draft reads", c.Name)
		}
		if !c.OK {
			continue
		}
		want, err := build(c.Tokens)
		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		if got := show(forms); got != want {
			t.Errorf("%s:\n draft reads %s\n tokens make %s", c.Name, got, want)
		}
	}
}

// build is the forms tokens make, written as show writes draft's.
func build(tokens [][2]string) (string, error) {
	var b strings.Builder
	depth := 0
	for _, tk := range tokens {
		switch kind, text := tk[0], tk[1]; kind {
		case "space", "comment":
		case "paren":
			if text == "(" {
				b.WriteString("[ ")
				depth++
			} else {
				if depth == 0 {
					return "", fmt.Errorf("unmatched )")
				}
				b.WriteString("] ")
				depth--
			}
		case "str":
			s, err := unquote(text)
			if err != nil {
				return "", err
			}
			fmt.Fprintf(&b, "str:%q ", s)
		case "word":
			fmt.Fprintf(&b, "atom:%q ", text)
		default:
			return "", fmt.Errorf("token kind %q", kind)
		}
	}
	if depth != 0 {
		return "", fmt.Errorf("unmatched (")
	}
	return b.String(), nil
}

// unquote unescapes a string token as draft's grammar defines strings.
func unquote(text string) (string, error) {
	if len(text) < 2 || text[0] != '"' || text[len(text)-1] != '"' {
		return "", fmt.Errorf("string token %q", text)
	}
	var b strings.Builder
	in := text[1 : len(text)-1]
	for i := 0; i < len(in); i++ {
		if in[i] != '\\' {
			b.WriteByte(in[i])
			continue
		}
		i++
		if i == len(in) {
			return "", fmt.Errorf("string token %q", text)
		}
		switch in[i] {
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case 'r':
			b.WriteByte('\r')
		case '"', '\\':
			b.WriteByte(in[i])
		default:
			return "", fmt.Errorf("escape in %q", text)
		}
	}
	return b.String(), nil
}

// show writes draft's forms: lists bracketed, strings unescaped, atoms as
// spelled (a keyword with its colon).
func show(forms []sexpr.Form) string {
	var b strings.Builder
	var walk func(f sexpr.Form)
	walk = func(f sexpr.Form) {
		switch f.Kind {
		case sexpr.KindList:
			b.WriteString("[ ")
			for _, g := range f.Items {
				walk(g)
			}
			b.WriteString("] ")
		case sexpr.KindString:
			fmt.Fprintf(&b, "str:%q ", f.Text)
		case sexpr.KindKeyword:
			fmt.Fprintf(&b, "atom:%q ", ":"+f.Text)
		default:
			fmt.Fprintf(&b, "atom:%q ", f.Text)
		}
	}
	for _, f := range forms {
		walk(f)
	}
	return b.String()
}
