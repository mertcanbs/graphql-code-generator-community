import { extname } from 'path';
import {
  concatAST,
  EnumTypeDefinitionNode,
  FragmentDefinitionNode,
  GraphQLSchema,
  InputObjectTypeDefinitionNode,
  Kind,
  OperationDefinitionNode,
} from 'graphql';
import gql from 'graphql-tag';
import { CSharpDeclarationBlock } from '@graphql-codegen/c-sharp-common';
import {
  getCachedDocumentNodeFromSchema,
  PluginFunction,
  PluginValidateFn,
  Types,
} from '@graphql-codegen/plugin-helpers';
import { LoadedFragment } from '@graphql-codegen/visitor-plugin-common';
import { CSharpOperationsRawPluginConfig } from './config.js';
import { CSharpOperationsVisitor } from './visitor.js';

export const plugin: PluginFunction<CSharpOperationsRawPluginConfig> = (
  schema: GraphQLSchema,
  documents: Types.DocumentFile[],
  config,
) => {
  const schemaAST = getCachedDocumentNodeFromSchema(schema);
  const allAst = concatAST(documents.map(v => v.document).concat(schemaAST));
  const allFragments: LoadedFragment[] = [
    ...(
      allAst.definitions.filter(
        d => d.kind === Kind.FRAGMENT_DEFINITION,
      ) as FragmentDefinitionNode[]
    ).map(fragmentDef => ({
      node: fragmentDef,
      name: fragmentDef.name.value,
      onType: fragmentDef.typeCondition.name.value,
      isExternal: false,
    })),
    ...(config.externalFragments || []),
  ];
  //
  const allOperations = allAst.definitions.filter(
    d => d.kind === Kind.OPERATION_DEFINITION,
  ) as OperationDefinitionNode[];
  const allInputTypes = allAst.definitions.filter(
    d => d.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION,
  ) as InputObjectTypeDefinitionNode[];
  const allEnumTypes = allAst.definitions.filter(
    d => d.kind === Kind.ENUM_TYPE_DEFINITION,
  ) as EnumTypeDefinitionNode[];
  const visitor = new CSharpOperationsVisitor(schema, allFragments, config, documents);

  let inputDefinitions = '';
  allInputTypes.forEach(inputType => {
    const inputDefinition = visitor.InputObjectTypeDefinition(inputType);
    inputDefinitions += inputDefinition;
    inputDefinitions += '\n';
  });

  let fragmentDefinitions = '';
  allFragments.forEach(fragment => {
    const fragmentDefinition = visitor.getFragmentClass(fragment.node);
    fragmentDefinitions += fragmentDefinition;
    fragmentDefinitions += '\n';
  });

  let operationInterfaceMethods = '';
  allOperations.forEach(operation => {
    const operationInterfaceMethod = visitor.getOperationInterfaceMethods(operation);
    operationInterfaceMethods += operationInterfaceMethod;
    operationInterfaceMethods += '\n';
  });

  let operationDefinitions = '';
  allOperations.forEach(operation => {
    const operationDefinition = visitor.getOperationConcreteMethod(operation);
    operationDefinitions += operationDefinition;
    operationDefinitions += '\n';
  });

  let requestDefinitions = '';
  allOperations.forEach(operation => {
    const requestDefinition = visitor.getRequestClass(operation);
    requestDefinitions += requestDefinition;
    requestDefinitions += '\n';
  });

  let responseDefinitions = '';
  allOperations.forEach(operation => {
    const responseDefinition = visitor.getResponseClass(operation);
    responseDefinitions += responseDefinition;
    responseDefinitions += '\n';
  });

  let enumDefinitions = '';
  allEnumTypes.forEach(enumType => {
    const enumDefinition = visitor.getEnumDefinition(enumType);
    enumDefinitions += enumDefinition;
    enumDefinitions += '\n';
  });

  const clientInterfaceName = 'I' + config.operationsClassName;

  const clientInterface = new CSharpDeclarationBlock()
    .access('public')
    .asKind('interface')
    .withName(clientInterfaceName)
    .withBlock(operationInterfaceMethods).string;

  const clientClass = new CSharpDeclarationBlock()
    .access('public')
    .asKind('class')
    .withName(config.operationsClassName)
    .implements([clientInterfaceName])
    .withBlock([visitor.getClientDeclaration(), operationDefinitions].join('\n')).string;

  const blockContent = [
    clientInterface,
    clientClass,
    requestDefinitions,
    responseDefinitions,
    fragmentDefinitions,
    inputDefinitions,
    enumDefinitions,
    visitor.getHttpRequestClass(),
    visitor.getHasErrorExtension(),
  ].join('\n');

  const wrappedContent = visitor.wrapWithNamespace(blockContent, visitor.config.namespaceName);

  const imports = visitor.getCSharpImports();
  return [imports, wrappedContent].join('\n');
};

export const addToSchema = gql`
  directive @namedClient(name: String!) on OBJECT | FIELD
`;

export const validate: PluginValidateFn = async (
  schema: GraphQLSchema,
  documents: Types.DocumentFile[],
  config,
  outputFile: string,
) => {
  if (extname(outputFile) !== '.cs') {
    throw new Error(`Plugin "c-sharp-operations" requires extension to be ".cs"!`);
  }
};

export { CSharpOperationsVisitor };
