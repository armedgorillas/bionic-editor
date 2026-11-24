# Spec for Bionic Editor

A scientific document editor.

This is the specification for a scientific analysis editor. This is funcitonally similar to an IDE, but the audience is biologists: analytical people who have no exposure to software development practices. This outlines what the software should do and how it should be constructed.

## What it is

The bionic editor is like an IDE for non-coder scientists. It has a file explorer, text editor, and AI chat panel. The purpose of the software is to give non-coder users access to the functions of AI coding agent harness but not overwhelm them with software development interfaces they won't understand. It should gently introduce software development best practices.

Users will use this to write scientific documents, including data analysis and reports alongside an AI agent. So, the editor software needs to provide an editing experience a user will understand alongside a text experience an AI agent will understand.

An example use case is data analysis. Imagine the user is given a set of raw data sets and knows how to analyze them (and would be able to do it in excel). Instead, they can describe how to analyze the data to the agent, who would then write python code to analyze the data. The user might now be able to understand the python code, but all code is saved alongside the proejct spec, so it can be inspected by someone who does.

A second example is collation of scientific reports. Say the user is given a half dozen raw lab notebook entry. They can then write a spec for an AI agent to collate those into a single report. Intead of a back-and-forth chat that is not grokable, the instructions the user develops with the agent are saved as a plan, which is reproducible and auditable.

### File explorer

The file explorer is just like any other file explorer where users can open, create, edit, move, delete files. This is the same as the VS code editor.

Each time the user does an analysis, there should be some default file structure. The main file is called SPEC.md where the user writes the instructions for the AI agent. The AI agent then can edit that file to help flesh out the plan. Then the AI agent can implement the plan by writing code which is stored locally. Code should always use a virtual env set up declaratively within the project directory. Cookie cutter data science should be an inspiration for the default project layout.

There should be an aditional directory called "web-report" which automatically renders a simple html server viewable to the user. This is so the ai agent can write html reports with interactive visualizations.

### File viewer

The main window of the application should be a simple WYSIWYG editor for markdown files. The user experience should be similar to Bear, which I am typing on now. Users should be able to view text as normal (i.e. not monospaced) text and have minimal formatting options, including headers, enumeration, bullets, bold, italics, images, and links. The Text should allow for inline images (referenced to local files). 

The underlying data should be raw text so that the agents should be able to read it. All non-markdown files are viewed as raw code like VS Code.

### AI agent

There should be an AI agent panel. The agent should operate like a coding harness, where it looks for files in the local directory and has limited permissions. It should have an estimate of current token usage like opencode does. However, the agent should not be in the format of the terminal: it should render the text as normal text for the user. Everything else should be similar to a coding agent.

## App structure

Ideally, this is based on VS Code, but the text editor and AI agent panels are new and not currently supported out of the box. Everything else in VS Code should be hidden from the user so as to not confuse them. There should be an option called "turn on coding mode" which unhides all the VS Code things like git branching, extensions, debug mode, etc. If a basic extension cannot accomplish this, fork the VS code repo and make the changes.

## Distribution

To start, this app should be web-only. IE it will be run on a webserver and forwarded to the user. If there are multiple ports involved, please highlight as part of the plan as only one port is exposted to the reverse proxy from the machine. This is changable but should be incorporated in the plan.


